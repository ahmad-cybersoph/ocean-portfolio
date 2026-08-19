/* ---------------------------------------------------------------------------
   RippleWater — a WebGL water surface that refracts whatever is under it.

   The surface is a height field solved on the GPU (see shaders.ts). Touching it
   stamps a drop; the drop rebounds into a ring that spreads, interferes with
   every other ring on the surface, loses energy and dies. The composite pass
   turns the height field into a normal and bends the scene through it, so the
   seabed and the hero portrait actually move under the water rather than
   sitting behind a decorative overlay.

   The class owns no DOM beyond the canvas it is handed, and every entry point
   is safe to call before or after dispose().
--------------------------------------------------------------------------- */

import * as THREE from "three";
import {
  COMPOSITE_FRAG,
  DROP_FRAG,
  MAX_BUBBLES,
  MAX_DROPS,
  OCEAN_FRAG,
  SIM_FRAG,
  VERT,
} from "./shaders";

/** A rectangle in canvas UV space: x/y are the bottom-left corner, y points up. */
export interface UvRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RippleWaterOptions {
  /** Hero image to sink into the water. Omit for water only. */
  portraitUrl?: string;
  /** Sun position across the surface, 0..1. Matches the old LIGHT_X. */
  lightX?: number;
  /** Peak alpha of the readability scrim. Matches the old SCRIM. */
  scrim?: number;
  reducedMotion?: boolean;
  /** Fires once the hero image is on the GPU, so the DOM copy can step aside. */
  onPortraitReady?: () => void;
}

/* ---- feel ----------------------------------------------------------------
   Tuned for the Samsung lock-screen character: a soft, wide push rather than a
   sharp splash, a bend big enough to read as glass, and a decay of a couple of
   seconds so the surface always settles back to calm.

   Everything here is expressed in screen and wall-clock units — heights per
   second, amplitude per second — never per simulation step. The step rate is
   derived from them below. That matters: this solver moves waves at a fixed
   number of *grid cells* per step, so a denser grid means slower water. Left
   alone, ripples would crawl on a big display and visibly change speed the
   moment the quality ladder swapped grids underneath them.                    */
const FEEL = {
  tension: 1.55, // wave stiffness; >2 breaks the CFL limit and blows up
  waveSpeed: 0.6, // screen heights per second
  // Amplitude left after one second. A spreading ring also thins as 1/sqrt(r)
  // on its own, so this only has to supply the last of the fade — pushed too
  // low it snuffs the ripple out before it has crossed any real distance.
  ampDecay: 0.5,
  edgeDecay: 0.02, // border energy left after one second (absorbing boundary)
  slope: 0.22, // height gradient -> surface tilt
  refract: 0.042, // surface tilt -> uv bend, in uv units
  calm: 0.015, // idle swell, so still water still breathes
  specular: 0.3,
  lens: 0.0015, // curvature -> brightness, the bright edge on each ring
  tap: { radius: 0.085, strength: -0.055 },
  /** A move drop is scaled by pointer speed, then capped. */
  move: { radius: 0.034, perUnit: -0.55, cap: -0.018 },
};

const FEEL_REDUCED: typeof FEEL = {
  ...FEEL,
  ampDecay: 0.02, // gone in well under a second
  calm: 0,
  refract: 0.028,
  specular: 0.18,
  tap: { radius: 0.075, strength: -0.03 },
};

/* Quality ladder. Index 0 is the best; the loop walks down if frames slip.
   simH is the height of the wave grid in cells and does NOT follow the display
   — a 4K monitor solves the same water a phone does, just shown larger. */
const TIERS = [
  { dpr: 2, oceanScale: 0.75, oceanMax: 1600, simH: 320 },
  { dpr: 1.75, oceanScale: 0.65, oceanMax: 1280, simH: 272 },
  { dpr: 1.5, oceanScale: 0.55, oceanMax: 1024, simH: 224 },
  { dpr: 1.25, oceanScale: 0.5, oceanMax: 900, simH: 176 },
];

/** Grid cells a wave front advances per step, for the solver in SIM_FRAG. */
const cellsPerStep = (tension: number) => Math.sqrt(tension) / 2;
/** Frames slower than this count against the current quality tier. */
const SLOW_FRAME_MS = 20;
/** After this long with no input, a reduced-motion surface stops redrawing. */
const REDUCED_IDLE_MS = 2500;

interface PendingDrop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  strength: number;
}

interface Pointer {
  x: number;
  y: number;
  px: number;
  py: number;
  fresh: boolean;
}

/* ---- WebGL capability probing ------------------------------------------ */

/** Cheap up-front check: is there a GL context at all? */
export function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const gl =
      c.getContext("webgl2") ||
      c.getContext("webgl") ||
      c.getContext("experimental-webgl");
    return !!gl;
  } catch {
    return false;
  }
}

/** Can we actually render into a target of this type? Extensions lie; FBOs do not. */
function canRenderTo(
  renderer: THREE.WebGLRenderer,
  type: THREE.TextureDataType,
): boolean {
  let rt: THREE.WebGLRenderTarget | null = null;
  try {
    rt = new THREE.WebGLRenderTarget(4, 4, {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    renderer.setRenderTarget(rt);
    renderer.clear();
    const gl = renderer.getContext();
    const ok =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.setRenderTarget(null);
    return ok;
  } catch {
    return false;
  } finally {
    rt?.dispose();
  }
}

export class RippleWater {
  private canvas: HTMLCanvasElement;
  private opts: {
    lightX: number;
    scrim: number;
    reducedMotion: boolean;
    portraitUrl?: string;
    onPortraitReady?: () => void;
  };

  private renderer!: THREE.WebGLRenderer;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private geo!: THREE.PlaneGeometry;

  private simMat!: THREE.ShaderMaterial;
  private dropMat!: THREE.ShaderMaterial;
  private oceanMat!: THREE.ShaderMaterial;
  private compMat!: THREE.ShaderMaterial;
  private simScene!: THREE.Scene;
  private dropScene!: THREE.Scene;
  private oceanScene!: THREE.Scene;
  private compScene!: THREE.Scene;

  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private rtOcean: THREE.WebGLRenderTarget | null = null;
  private simType: THREE.TextureDataType = THREE.HalfFloatType;
  private simFilter: typeof THREE.LinearFilter | typeof THREE.NearestFilter =
    THREE.LinearFilter;

  private portraitTex: THREE.Texture | null = null;
  private portraitRectSet = false;

  private tier = 0;
  private raf = 0;
  private running = false;
  private disposed = false;
  private visible = true;
  private inView = true;

  private clockStart = 0;
  private lastFrame = 0;
  private simTime = 0; // scene animation clock, in seconds
  private accum = 0;
  private lastInputAt = 0;

  /** Solver rate and budget, both derived from the grid in use. */
  private step = 1 / 240;
  private maxSteps = 8;
  private simH = TIERS[0].simH;
  /** Everything resize() derives its buffer sizes from, for change detection. */
  private sizeKey = "";

  private slowWindows = 0;
  private windowFrames = 0;
  private windowMs = 0;

  private pointers = new Map<number, Pointer>();
  private pending: PendingDrop[] = [];

  private bubbles: THREE.Vector4[] = [];
  private bubbleHead = 0;
  private lastBubbleAt = new THREE.Vector2(-9, -9);

  private dropSeg: THREE.Vector4[] = [];
  private dropShape: THREE.Vector2[] = [];

  private feel: typeof FEEL = FEEL;

  constructor(canvas: HTMLCanvasElement, options: RippleWaterOptions = {}) {
    this.canvas = canvas;
    this.opts = {
      lightX: options.lightX ?? 0.62,
      scrim: options.scrim ?? 0.42,
      reducedMotion: options.reducedMotion ?? false,
      portraitUrl: options.portraitUrl,
      onPortraitReady: options.onPortraitReady,
    };
    this.feel = this.opts.reducedMotion ? FEEL_REDUCED : FEEL;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: false,
    });

    // The sim needs signed, high-range texels. A byte target cannot hold them,
    // and a silently-wrong sim looks worse than no sim at all.
    const type = [THREE.HalfFloatType, THREE.FloatType].find((t) =>
      canRenderTo(this.renderer, t),
    );
    if (type === undefined) {
      this.renderer.dispose();
      throw new Error("no float render target");
    }
    this.simType = type;

    const gl = this.renderer.getContext();
    const linearOK =
      this.renderer.capabilities.isWebGL2 ||
      (type === THREE.HalfFloatType
        ? !!gl.getExtension("OES_texture_half_float_linear")
        : !!gl.getExtension("OES_texture_float_linear"));
    this.simFilter = linearOK ? THREE.LinearFilter : THREE.NearestFilter;

    this.tier = this.startTier();
    this.geo = new THREE.PlaneGeometry(2, 2);

    for (let i = 0; i < MAX_BUBBLES; i++)
      this.bubbles.push(new THREE.Vector4(0, 0, -99, 0));
    for (let i = 0; i < MAX_DROPS; i++) {
      this.dropSeg.push(new THREE.Vector4());
      this.dropShape.push(new THREE.Vector2());
    }

    this.buildMaterials();
    this.resize();
    if (this.opts.portraitUrl) this.loadPortrait(this.opts.portraitUrl);

    this.clockStart = performance.now();
    this.lastFrame = this.clockStart;
    this.lastInputAt = this.clockStart;
    this.attachInput();
  }

  /* ---- setup ----------------------------------------------------------- */

  private startTier(): number {
    const coarse =
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches;
    const cores = navigator.hardwareConcurrency ?? 4;
    if (coarse || cores <= 4) return 1;
    return 0;
  }

  private buildMaterials() {
    const f = this.feel;

    this.simMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: SIM_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        // Filled in by applyRate() once the grid size is known.
        u_prev: { value: null },
        u_texel: { value: new THREE.Vector2() },
        u_damping: { value: 0.995 },
        u_tension: { value: f.tension },
        u_absorb: { value: 0.98 },
      },
    });

    this.dropMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DROP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_prev: { value: null },
        u_dropSeg: { value: this.dropSeg },
        u_dropShape: { value: this.dropShape },
        u_dropCount: { value: 0 },
        u_aspect: { value: 1 },
      },
    });

    this.oceanMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: OCEAN_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_time: { value: 0 },
        u_aspect: { value: 1 },
        u_lightX: { value: this.opts.lightX },
        u_scrim: { value: this.opts.scrim },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_bubbles: { value: this.bubbles },
      },
    });

    this.compMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_scene: { value: null },
        u_sim: { value: null },
        u_portrait: { value: null },
        u_simTexel: { value: new THREE.Vector2() },
        u_portraitBox: { value: new THREE.Vector4() },
        u_portraitImg: { value: new THREE.Vector4() },
        u_hasPortrait: { value: 0 },
        u_refract: { value: f.refract },
        u_slope: { value: f.slope },
        u_calm: { value: f.calm },
        u_specular: { value: f.specular },
        u_lens: { value: f.lens },
        u_time: { value: 0 },
      },
    });

    const stage = (mat: THREE.ShaderMaterial) => {
      const s = new THREE.Scene();
      s.add(new THREE.Mesh(this.geo, mat));
      return s;
    };
    this.simScene = stage(this.simMat);
    this.dropScene = stage(this.dropMat);
    this.oceanScene = stage(this.oceanMat);
    this.compScene = stage(this.compMat);
  }

  private loadPortrait(url: string) {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }
        // NoColorSpace: the composite pass wants the raw sRGB values so it can
        // blend the portrait the way the browser blended the <img> it replaces.
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.magFilter = THREE.LinearFilter;
        // 672x926 is not a power of two, so WebGL1 cannot mip it.
        const canMip = this.renderer.capabilities.isWebGL2;
        tex.generateMipmaps = canMip;
        tex.minFilter = canMip
          ? THREE.LinearMipmapLinearFilter
          : THREE.LinearFilter;
        tex.anisotropy = Math.min(
          4,
          this.renderer.capabilities.getMaxAnisotropy(),
        );
        tex.needsUpdate = true;
        this.portraitTex = tex;
        this.compMat.uniforms.u_portrait.value = tex;
        this.compMat.uniforms.u_hasPortrait.value = this.portraitRectSet ? 1 : 0;
        this.opts.onPortraitReady?.();
      },
      undefined,
      () => {
        /* the DOM <img> fallback stays visible if this never arrives */
      },
    );
  }

  /* ---- sizing ---------------------------------------------------------- */

  resize() {
    if (this.disposed) return;
    const tier = TIERS[this.tier];
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dpr);

    // Reallocating three render targets is not something to do on a spurious
    // notification — and mobile sends plenty as the URL bar slides. Bail unless
    // something that actually sizes a buffer moved.
    const key = `${w}x${h}@${dpr}#${this.tier}`;
    if (key === this.sizeKey) return;
    this.sizeKey = key;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    this.dropMat.uniforms.u_aspect.value = aspect;
    this.oceanMat.uniforms.u_aspect.value = aspect;
    this.oceanMat.uniforms.u_resolution.value.set(w, h);

    // Ocean pass: below display resolution and capped in absolute pixels.
    // Nothing in it has a hard edge, and the refraction resamples it anyway;
    // the portrait, which does have edges, is sampled at full res downstream.
    const tw = w * dpr * tier.oceanScale;
    const th = h * dpr * tier.oceanScale;
    const fit = Math.min(1, tier.oceanMax / Math.max(tw, th));
    const ow = Math.max(2, Math.round(tw * fit));
    const oh = Math.max(2, Math.round(th * fit));

    // Sim grid: a fixed cell count, widened to the viewport aspect so one cell
    // covers the same distance on both axes and waves stay circular on screen.
    const sh = tier.simH;
    const sw = Math.max(2, Math.min(1024, Math.round(sh * aspect)));
    this.simH = sh;
    this.applyRate(sh);

    this.rtOcean?.dispose();
    this.rtOcean = new THREE.WebGLRenderTarget(ow, oh, {
      type: this.simType, // dark linear blues band badly in 8 bits
      format: THREE.RGBAFormat,
      minFilter: this.simFilter,
      magFilter: this.simFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.rtA?.dispose();
    this.rtB?.dispose();
    const simOpts = {
      type: this.simType,
      format: THREE.RGBAFormat,
      minFilter: this.simFilter,
      magFilter: this.simFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(sw, sh, simOpts);
    this.rtB = new THREE.WebGLRenderTarget(sw, sh, simOpts);
    // A resize hands us fresh targets, so zero both halves — otherwise the
    // first frame reads whatever was in that memory.
    this.clearSim();

    const texel = new THREE.Vector2(1 / sw, 1 / sh);
    this.simMat.uniforms.u_texel.value.copy(texel);
    this.compMat.uniforms.u_simTexel.value.copy(texel);
  }

  /* Convert the wall-clock feel into per-step solver constants for this grid.
     Step rate rises with the grid so the wave front covers the same fraction
     of the screen per second whatever the quality tier, and the two decay
     factors are re-rooted to that rate so the tail keeps its length too. */
  private applyRate(simH: number) {
    const f = this.feel;
    const hz = Math.min(
      480,
      Math.max(60, (f.waveSpeed * simH) / cellsPerStep(f.tension)),
    );
    this.step = 1 / hz;
    // Enough headroom to hold full speed down to 30fps; below that the water
    // slows rather than spiralling as the loop tries to catch up.
    this.maxSteps = Math.max(2, Math.ceil(hz / 30));
    this.simMat.uniforms.u_tension.value = f.tension;
    this.simMat.uniforms.u_damping.value = Math.exp(Math.log(f.ampDecay) / hz);
    this.simMat.uniforms.u_absorb.value = Math.exp(Math.log(f.edgeDecay) / hz);
  }

  private clearSim() {
    const prev = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const rt of [this.rtA, this.rtB]) {
      if (!rt) continue;
      this.renderer.setRenderTarget(rt);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prev, prevAlpha);
  }

  /** Element box and object-contain box of the hero image, in canvas UV. */
  setPortraitRect(box: UvRect | null, img: UvRect | null) {
    if (this.disposed) return;
    if (!box || !img) {
      this.portraitRectSet = false;
      this.compMat.uniforms.u_hasPortrait.value = 0;
      return;
    }
    this.compMat.uniforms.u_portraitBox.value.set(box.x0, box.y0, box.x1, box.y1);
    this.compMat.uniforms.u_portraitImg.value.set(img.x0, img.y0, img.x1, img.y1);
    this.portraitRectSet = true;
    this.compMat.uniforms.u_hasPortrait.value = this.portraitTex ? 1 : 0;
  }

  /** True once the hero image is on the GPU and can be drawn refracted. */
  get portraitReady() {
    return !!this.portraitTex;
  }

  /* ---- input ----------------------------------------------------------- */

  private toUv(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / Math.max(r.width, 1),
      y: 1 - (e.clientY - r.top) / Math.max(r.height, 1),
    };
  }

  private onMove = (e: PointerEvent) => {
    const p = this.toUv(e);
    if (p.x < -0.2 || p.x > 1.2 || p.y < -0.2 || p.y > 1.2) return;
    const prev = this.pointers.get(e.pointerId);
    if (prev) {
      prev.x = p.x;
      prev.y = p.y;
    } else {
      this.pointers.set(e.pointerId, {
        x: p.x,
        y: p.y,
        px: p.x,
        py: p.y,
        fresh: true,
      });
    }
    this.lastInputAt = performance.now();
    this.updateRunState();
  };

  private onDown = (e: PointerEvent) => {
    const p = this.toUv(e);
    this.pointers.set(e.pointerId, {
      x: p.x,
      y: p.y,
      px: p.x,
      py: p.y,
      fresh: true,
    });
    const tap = this.feel.tap;
    this.pending.push({
      x0: p.x,
      y0: p.y,
      x1: p.x,
      y1: p.y,
      radius: tap.radius,
      strength: tap.strength,
    });
    if (!this.opts.reducedMotion) {
      for (let i = 0; i < 18; i++)
        this.spawnBubble(
          p.x + (Math.random() - 0.5) * 0.05,
          p.y + (Math.random() - 0.5) * 0.03,
          0.006 + Math.random() * 0.013,
        );
    }
    this.lastInputAt = performance.now();
    this.updateRunState();
  };

  private onEnd = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };

  private onLeave = (e: PointerEvent) => {
    // relatedTarget is null when the pointer actually left the window, as
    // opposed to crossing between elements inside it.
    if (e.relatedTarget === null) this.pointers.delete(e.pointerId);
  };

  private attachInput() {
    const passive = { passive: true } as const;
    window.addEventListener("pointermove", this.onMove, passive);
    window.addEventListener("pointerdown", this.onDown, passive);
    window.addEventListener("pointerup", this.onEnd, passive);
    window.addEventListener("pointercancel", this.onEnd, passive);
    window.addEventListener("pointerout", this.onLeave, passive);
  }

  private detachInput() {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onEnd);
    window.removeEventListener("pointercancel", this.onEnd);
    window.removeEventListener("pointerout", this.onLeave);
  }

  private spawnBubble(x: number, y: number, size: number) {
    this.bubbles[this.bubbleHead].set(x, y, this.simTime, size);
    this.bubbleHead = (this.bubbleHead + 1) % MAX_BUBBLES;
  }

  /** One trailing capsule per pointer per frame keeps the wake continuous. */
  private collectTrails() {
    if (this.opts.reducedMotion) {
      for (const p of this.pointers.values()) {
        p.px = p.x;
        p.py = p.y;
        p.fresh = false;
      }
      return;
    }
    const aspect = this.dropMat.uniforms.u_aspect.value as number;
    const mv = this.feel.move;
    for (const p of this.pointers.values()) {
      if (p.fresh) {
        p.px = p.x;
        p.py = p.y;
        p.fresh = false;
        continue;
      }
      const dx = (p.x - p.px) * aspect;
      const dy = p.y - p.py;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.0015) continue;

      const strength = Math.max(mv.cap, mv.perUnit * Math.min(dist, 0.12));
      this.pending.push({
        x0: p.px,
        y0: p.py,
        x1: p.x,
        y1: p.y,
        radius: mv.radius,
        strength,
      });

      if (Math.hypot(p.x - this.lastBubbleAt.x, p.y - this.lastBubbleAt.y) > 0.012) {
        const n = Math.min(3, 1 + Math.floor(dist * 28));
        for (let i = 0; i < n; i++)
          this.spawnBubble(
            p.x + (Math.random() - 0.5) * 0.012,
            p.y + (Math.random() - 0.5) * 0.012,
            0.006 + Math.random() * 0.008,
          );
        this.lastBubbleAt.set(p.x, p.y);
      }

      p.px = p.x;
      p.py = p.y;
    }
  }

  /* ---- frame ----------------------------------------------------------- */

  /** Render one pass into the back buffer and make it the front buffer. */
  private pingPong(scene: THREE.Scene, mat: THREE.ShaderMaterial) {
    const front = this.rtA;
    const back = this.rtB;
    if (!front || !back) return;
    mat.uniforms.u_prev.value = front.texture;
    this.renderer.setRenderTarget(back);
    this.renderer.render(scene, this.cam);
    this.rtA = back;
    this.rtB = front;
  }

  private flushDrops() {
    if (!this.pending.length) return;
    // At most two passes per frame; anything beyond that is a runaway input
    // queue and dropping it is cheaper than stalling the frame.
    for (let pass = 0; pass < 2 && this.pending.length; pass++) {
      const batch = this.pending.splice(0, MAX_DROPS);
      for (let i = 0; i < batch.length; i++) {
        const d = batch[i];
        this.dropSeg[i].set(d.x0, d.y0, d.x1, d.y1);
        this.dropShape[i].set(d.radius, d.strength);
      }
      this.dropMat.uniforms.u_dropCount.value = batch.length;
      this.pingPong(this.dropScene, this.dropMat);
    }
    this.pending.length = 0;
  }

  private simStep() {
    this.pingPong(this.simScene, this.simMat);
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);

    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.min(0.05, Math.max(0, rawDt));
    // Reduced motion keeps the scene animation almost still; the ripples
    // themselves still resolve so a tap is not a dead no-op.
    this.simTime += dt * (this.opts.reducedMotion ? 0.12 : 1);

    this.collectTrails();
    this.flushDrops();

    this.accum += dt;
    let steps = 0;
    while (this.accum >= this.step && steps < this.maxSteps) {
      this.simStep();
      this.accum -= this.step;
      steps++;
    }
    if (this.accum > this.step) this.accum = 0; // back from a stall; don't catch up

    if (!this.rtOcean || !this.rtA) return;

    this.oceanMat.uniforms.u_time.value = this.simTime;
    this.renderer.setRenderTarget(this.rtOcean);
    this.renderer.render(this.oceanScene, this.cam);

    this.compMat.uniforms.u_scene.value = this.rtOcean.texture;
    this.compMat.uniforms.u_sim.value = this.rtA.texture;
    this.compMat.uniforms.u_time.value = this.simTime;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.cam);

    this.trackPerf(now, rawDt * 1000);

    if (
      this.opts.reducedMotion &&
      now - this.lastInputAt > REDUCED_IDLE_MS
    ) {
      this.stop(); // hold the last frame; a tap wakes it back up
    }
  };

  /** Walk down the quality ladder if frames keep missing the budget. */
  private trackPerf(now: number, frameMs: number) {
    if (now - this.clockStart < 1200) return; // shader compile + warmup
    this.windowFrames++;
    this.windowMs += frameMs;
    if (this.windowFrames < 60) return;

    const mean = this.windowMs / this.windowFrames;
    this.windowFrames = 0;
    this.windowMs = 0;

    if (mean > SLOW_FRAME_MS) {
      this.slowWindows++;
      if (this.slowWindows >= 2 && this.tier < TIERS.length - 1) {
        this.tier++;
        this.slowWindows = 0;
        this.resize();
      }
    } else {
      this.slowWindows = 0;
    }
  }

  /* ---- lifecycle ------------------------------------------------------- */

  setVisible(v: boolean) {
    this.visible = v;
    this.updateRunState();
  }

  setInView(v: boolean) {
    this.inView = v;
    this.updateRunState();
  }

  setReducedMotion(reduced: boolean) {
    if (this.opts.reducedMotion === reduced) return;
    this.opts.reducedMotion = reduced;
    this.feel = reduced ? FEEL_REDUCED : FEEL;
    const f = this.feel;
    this.applyRate(this.simH);
    this.compMat.uniforms.u_refract.value = f.refract;
    this.compMat.uniforms.u_calm.value = f.calm;
    this.compMat.uniforms.u_specular.value = f.specular;
    this.lastInputAt = performance.now();
    this.updateRunState();
  }

  private updateRunState() {
    const idleOut =
      this.opts.reducedMotion &&
      performance.now() - this.lastInputAt > REDUCED_IDLE_MS;
    const shouldRun = !this.disposed && this.visible && this.inView && !idleOut;
    if (shouldRun) this.start();
    else this.stop();
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.accum = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.detachInput();
    this.pointers.clear();
    this.pending.length = 0;
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtOcean?.dispose();
    this.portraitTex?.dispose();
    this.geo.dispose();
    this.simMat.dispose();
    this.dropMat.dispose();
    this.oceanMat.dispose();
    this.compMat.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
