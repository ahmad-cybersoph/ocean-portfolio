"use client";

/**
 * OceanPortfolio — UNDERWATER scene: god-ray sunlight, seabed caustics, bubbles
 * -----------------------------------------------------------------------------
 * - Deep-blue underwater atmosphere with volumetric light shafts from the
 *   surface, caustic light-network on the seabed, and rising bubbles.
 * - Move the cursor => the water/light gently ripples & refracts.
 * - Click => a splash disturbance.
 *
 * NEXT.JS: rename to .tsx, add "use client" on top, `npm i three`,
 *          photo at public/portrait.png, edit CONFIG.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const CONFIG = {
  availability: ["AVAILABLE", "FOR HIRE"],
  availabilitySub: "REMOTELY",
  bigWord: "PORTFOLIO",
  name: "MUHAMED GHAREB",
  title: "SR.FRONTEND DEVELOPER",
  years: "+10 YEARS",
  tagline: ["Selected work across branding, digital,", "print, and visual communication."],
  photo: "/portrait.png",
};

/* ---- tune these ---- */
const DAMPING = 0.99;
const NORMAL_STRENGTH = 6.0;
const REFRACT = 0.020;   // ripple distortion (kept subtle; bubbles do the work)
const AMB = 0.008;
const LIGHT_X = 0.62;    // sun position across the surface (keeps left readable)
const SCRIM = 0.42;
const SIM_MAX = 760;

const vert = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const simFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_prev;
  uniform vec2  u_texel;
  uniform vec2  u_mouse;
  uniform vec2  u_mousePrev;
  uniform float u_force;
  uniform float u_radius;
  uniform vec2  u_click;
  uniform float u_clickForce;
  uniform float u_clickRadius;
  uniform float u_aspect;
  uniform float u_damping;
  float segDist(vec2 p, vec2 a, vec2 b){
    vec2 pa=p-a, ba=b-a;
    float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.0,1.0);
    return length(pa-ba*h);
  }
  void main(){
    vec2 uv=vUv;
    vec4 s=texture2D(u_prev,uv);
    float cur=s.r, prev=s.g;
    float l=texture2D(u_prev,uv-vec2(u_texel.x,0.0)).r;
    float r=texture2D(u_prev,uv+vec2(u_texel.x,0.0)).r;
    float u=texture2D(u_prev,uv+vec2(0.0,u_texel.y)).r;
    float d=texture2D(u_prev,uv-vec2(0.0,u_texel.y)).r;
    float newH=(l+r+u+d)*0.5-prev;
    newH*=u_damping;
    vec2 asp=vec2(u_aspect,1.0);
    float dd=segDist(uv*asp,u_mousePrev*asp,u_mouse*asp);
    newH-=u_force*exp(-(dd*dd)/(u_radius*u_radius));
    vec2 cd=(uv-u_click)*asp;
    newH-=u_clickForce*exp(-dot(cd,cd)/(u_clickRadius*u_clickRadius));
    gl_FragColor=vec4(newH,cur,0.0,1.0);
  }
`;

const dispFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_height;
  uniform vec2  u_texel;
  uniform float u_time;
  uniform float u_aspect;
  uniform vec4  u_bubbles[40];   // x, y, birthTime, size
  #define TAU 6.28318530718

  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  vec2  hash2(vec2 p){ vec3 a=fract(vec3(p.xyx)*vec3(123.34,234.34,345.65)); a+=dot(a,a+34.45); return fract(vec2(a.x*a.y,a.y*a.z)); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
    vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
  }
  float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.0+vec2(37,17); a*=0.5; } return v; }

  // caustic light network (seabed)
  float caustic(vec2 uv){
    float t=u_time*0.4+23.0;
    vec2 p=mod(uv*TAU,TAU)-250.0;
    vec2 i=p; float c=1.0; float inten=0.005;
    for(int n=0;n<5;n++){
      float tt=t*(1.0-(3.5/float(n+1)));
      i=p+vec2(cos(tt-i.x)+sin(tt+i.y),sin(tt-i.y)+cos(tt+i.x));
      c+=1.0/length(vec2(p.x/(sin(i.x+tt)/inten),p.y/(cos(i.y+tt)/inten)));
    }
    c/=5.0; c=1.17-pow(c,1.4);
    return 1.0-exp(-pow(abs(c),6.0)*0.9);
  }

  // volumetric light shafts from a source near the top surface
  float godRays(vec2 uv, vec2 asp, vec2 lp){
    float ang=(uv.x-lp.x)/max(lp.y-uv.y,0.06);
    float r=0.0;
    r += smoothstep(0.20,1.0, fbm(vec2(ang*7.0,  u_time*0.10)));
    r += 0.55*smoothstep(0.25,1.0, fbm(vec2(ang*13.0-5.0, u_time*0.16)));
    r *= smoothstep(-0.1,0.75, uv.y);
    r *= exp(-distance(uv*asp, lp*asp)*1.05);
    return r;
  }

  // sparse rising bubbles
  float bubbles(vec2 uv, vec2 asp){
    float b=0.0;
    for(int k=0;k<2;k++){
      float fk=float(k);
      vec2 g = uv*asp*(9.0+fk*7.0);
      g.y -= u_time*(0.35+fk*0.28);
      vec2 id=floor(g), f=fract(g);
      vec2 rnd=hash2(id);
      if(rnd.x>0.86){
        vec2 c=vec2(0.2+rnd.y*0.6, 0.3+fract(rnd.x*7.0)*0.4);
        float rad=0.05+rnd.y*0.05;
        b += smoothstep(rad, rad*0.25, length(f-c))*0.6;
      }
    }
    return b;
  }

  // sandy seabed: dunes + ripples + caustics, projected into perspective
  vec4 seabed(vec2 uv, vec2 asp){
    float horizon = 0.36;
    float below = horizon - uv.y;
    if (below <= 0.0) return vec4(0.0);
    float depth = 1.0 / max(below, 0.02);
    vec2 fuv = vec2((uv.x - 0.5) * depth, depth) * 0.32;

    // dune + ripple relief
    float dune   = fbm(fuv * vec2(1.6, 1.0));
    float ripple = fbm(fuv * vec2(2.0, 7.0) + vec2(0.0, u_time * 0.02));
    float relief = clamp(dune * 0.7 + ripple * 0.35, 0.0, 1.0);

    // caustics dancing on the sand
    float ca = caustic(fuv * 1.1 + vec2(u_time * 0.02, 0.0));

    // blue-tinted lit sand
    vec3 sand = mix(vec3(0.06, 0.16, 0.20), vec3(0.55, 0.72, 0.72), relief);
    sand += ca * vec3(0.55, 0.80, 0.85) * 0.9;

    // brighter under the light column, darker at the edges; nearer = brighter
    float pool = exp(-abs(uv.x - ${LIGHT_X.toFixed(2)}) * 2.2);
    sand *= 0.45 + 0.75 * pool;
    sand *= 0.35 + 0.65 * smoothstep(0.0, 0.22, below);

    // haze the distant sand into the water blue near the horizon
    float haze = smoothstep(0.0, 0.18, below);
    sand = mix(vec3(0.03, 0.16, 0.26), sand, haze);

    return vec4(sand, smoothstep(0.0, 0.06, below));
  }

  // realistic bubbles: thin bright rim + specular highlight dot, rising & wobbling
  vec3 interactiveBubbles(vec2 uv, vec2 asp){
    vec3 acc = vec3(0.0);
    const float life = 3.6;
    for (int i = 0; i < 40; i++) {
      vec4 b = u_bubbles[i];
      if (b.w <= 0.0) continue;
      float age = u_time - b.z;
      if (age < 0.0 || age > life) continue;
      float seed = fract(sin(b.x * 91.3 + b.y * 47.7) * 4137.1);
      float y = b.y + age * (0.055 + seed * 0.05);
      float x = b.x + sin(age * (3.0 + seed * 3.0) + seed * 6.28) * 0.012 * (0.5 + seed);
      float r = b.w * (0.6 + 0.4 * smoothstep(0.0, 0.4, age));
      float fin = smoothstep(0.0, 0.14, age);
      float fout = 1.0 - smoothstep(life * 0.6, life, age);
      float pop = 1.0 - smoothstep(0.92, 1.0, y);
      float f = fin * fout * pop;

      vec2 rel = (uv - vec2(x, y)) * asp;
      float d = length(rel) / r;                 // 0 center .. 1 edge
      if (d > 1.3) continue;
      float rim  = smoothstep(1.06, 0.92, d) - smoothstep(0.92, 0.72, d);   // bright edge
      vec2 ho = (rel / r) - vec2(-0.34, 0.34);                              // highlight upper-left
      float hi = exp(-dot(ho, ho) * 11.0);
      float fill = smoothstep(1.0, 0.5, d) * 0.05;                          // faint body
      acc += (vec3(0.75, 0.92, 1.0) * rim * 0.9 + vec3(1.0) * hi * 0.85 + vec3(0.5, 0.75, 0.85) * fill) * f;
    }
    return acc;
  }

  void main(){
    vec2 uv=vUv;
    vec2 asp=vec2(u_aspect,1.0);
    vec2 lp=vec2(${LIGHT_X.toFixed(2)}, 1.15);

    // ripple normal -> subtle refraction of the scene
    float hx=texture2D(u_height,uv+vec2(u_texel.x,0.0)).r - texture2D(u_height,uv-vec2(u_texel.x,0.0)).r;
    float hy=texture2D(u_height,uv+vec2(0.0,u_texel.y)).r - texture2D(u_height,uv-vec2(0.0,u_texel.y)).r;
    float ax=(sin(uv.x*90.0+u_time*1.2)+sin(uv.y*70.0-u_time*0.9))*0.5;
    float ay=(cos(uv.y*85.0+u_time*1.0)+sin(uv.x*75.0+u_time*0.8))*0.5;
    vec3 n=normalize(vec3(-(hx*${NORMAL_STRENGTH.toFixed(1)}+ax*${AMB.toFixed(3)}),
                          -(hy*${NORMAL_STRENGTH.toFixed(1)}+ay*${AMB.toFixed(3)}), 1.0));
    vec2 ruv = uv + n.xy * ${REFRACT.toFixed(3)};

    // deep underwater gradient (dark bottom -> lit surface)
    float g=clamp(ruv.y,0.0,1.0);
    vec3 bottomC=vec3(0.010,0.055,0.11);
    vec3 topC   =vec3(0.055,0.26,0.40);
    vec3 col=mix(bottomC, topC, pow(g,0.9));

    // sun glow through the surface
    float sun=exp(-distance(ruv*asp, lp*asp)*1.7);
    col += vec3(0.10,0.36,0.52)*sun*0.9;

    // sandy seabed with dunes + caustics (perspective)
    vec4 sb = seabed(ruv, asp);
    col = mix(col, sb.rgb, sb.a);

    // god-ray light shafts
    float rays=godRays(ruv, asp, lp);
    col += rays*vec3(0.28,0.58,0.78)*0.55;

    // bubbles
    col += bubbles(uv, asp)*vec3(0.55,0.78,0.88)*0.15;
    col += interactiveBubbles(uv, asp);

    // subtle specular sparkle on ripples
    vec3 L=normalize(vec3(-0.3,0.6,0.8));
    float spec=pow(max(dot(n,normalize(L+vec3(0,0,1))),0.0),140.0);
    col += vec3(0.5,0.8,0.95)*spec*0.25;

    // depth from ripple + vignette
    float h=texture2D(u_height,uv).r;
    col *= 1.0+clamp(h*2.0,-0.15,0.15);
    vec2 vv=uv-0.5;
    col *= 1.0 - 0.55*dot(vv, vv*vec2(0.85,1.05));
    col = pow(max(col,0.0), vec3(1.03));
    gl_FragColor=vec4(col,1.0);
  }
`;

export default function OceanPortfolio() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imgOk, setImgOk] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer!: THREE.WebGLRenderer;
    let raf = 0;
    const cleanup: Array<() => void> = [];

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const geo = new THREE.PlaneGeometry(2, 2);
      const MAXB = 40;
      const bub = Array.from({ length: MAXB }, () => new THREE.Vector4(0, 0, -99, 0));
      let bhead = 0;

      const rtOpts = {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false, stencilBuffer: false,
      };
      let rtA!: THREE.WebGLRenderTarget, rtB!: THREE.WebGLRenderTarget, simW: number, simH: number;

      const simMat = new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: simFrag,
        uniforms: {
          u_prev: { value: null }, u_texel: { value: new THREE.Vector2() },
          u_mouse: { value: new THREE.Vector2(-9, -9) },
          u_mousePrev: { value: new THREE.Vector2(-9, -9) },
          u_force: { value: 0 }, u_radius: { value: 0.02 },
          u_click: { value: new THREE.Vector2(-9, -9) },
          u_clickForce: { value: 0 }, u_clickRadius: { value: 0.055 },
          u_aspect: { value: 1 }, u_damping: { value: DAMPING },
        },
      });
      const dispMat = new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: dispFrag,
        uniforms: { u_height: { value: null }, u_texel: { value: new THREE.Vector2() }, u_time: { value: 0 }, u_aspect: { value: 1 }, u_bubbles: { value: bub } },
      });

      const simScene = new THREE.Scene(); simScene.add(new THREE.Mesh(geo, simMat));
      const dispScene = new THREE.Scene(); dispScene.add(new THREE.Mesh(geo, dispMat));

      const build = () => {
        const w = window.innerWidth, h = window.innerHeight;
        renderer.setSize(w, h, false);
        const aspect = w / h;
        const scale = Math.min(SIM_MAX / Math.max(w, h), 1);
        simW = Math.max(2, Math.floor(w * scale));
        simH = Math.max(2, Math.floor(h * scale));
        if (rtA) rtA.dispose(); if (rtB) rtB.dispose();
        rtA = new THREE.WebGLRenderTarget(simW, simH, rtOpts);
        rtB = new THREE.WebGLRenderTarget(simW, simH, rtOpts);
        const texel = new THREE.Vector2(1 / simW, 1 / simH);
        simMat.uniforms.u_texel.value.copy(texel);
        dispMat.uniforms.u_texel.value.copy(texel);
        simMat.uniforms.u_aspect.value = aspect;
        dispMat.uniforms.u_aspect.value = aspect;
      };
      build();
      window.addEventListener("resize", build);
      cleanup.push(() => window.removeEventListener("resize", build));

      const clock = new THREE.Clock();
      const mouse = new THREE.Vector2(-9, -9);
      const framePrev = new THREE.Vector2(-9, -9);
      let haveMouse = false, clickForce = 0;
      const lastSpawn = new THREE.Vector2(-9, -9);
      const spawnBubble = (x: number, y: number, size: number) => { bub[bhead].set(x, y, clock.getElapsedTime(), size); bhead = (bhead + 1) % MAXB; };

      const toUV = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return new THREE.Vector2((e.clientX - rect.left) / rect.width, 1 - (e.clientY - rect.top) / rect.height);
      };
      const onMove = (e: PointerEvent) => {
        const p = toUV(e);
        if (!haveMouse) { mouse.copy(p); framePrev.copy(p); lastSpawn.copy(p); haveMouse = true; return; }
        mouse.copy(p);
        const d = p.distanceTo(lastSpawn);
        if (d > 0.012) {                                  // bubble trail
          const n = Math.min(3, 1 + Math.floor(d * 28));
          for (let i = 0; i < n; i++)
            spawnBubble(p.x + (Math.random() - 0.5) * 0.012, p.y + (Math.random() - 0.5) * 0.012, 0.006 + Math.random() * 0.008);
          lastSpawn.copy(p);
        }
      };
      const onDown = (e: PointerEvent) => {
        const p = toUV(e); mouse.copy(p); simMat.uniforms.u_click.value.copy(p);
        clickForce = 0.5;                                  // softer shake
        for (let i = 0; i < 18; i++)                       // bubble burst
          spawnBubble(p.x + (Math.random() - 0.5) * 0.05, p.y + (Math.random() - 0.5) * 0.03, 0.006 + Math.random() * 0.013);
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerdown", onDown, { passive: true });
      cleanup.push(() => window.removeEventListener("pointermove", onMove));
      cleanup.push(() => window.removeEventListener("pointerdown", onDown));

      const frame = () => {
        const segLen = haveMouse ? mouse.distanceTo(framePrev) : 0;
        const dragForce = Math.min(0.09, segLen * 3.5);
        simMat.uniforms.u_prev.value = rtA.texture;
        simMat.uniforms.u_mouse.value.copy(mouse);
        simMat.uniforms.u_mousePrev.value.copy(framePrev);
        simMat.uniforms.u_force.value = dragForce;
        simMat.uniforms.u_clickForce.value = clickForce;
        renderer.setRenderTarget(rtB);
        renderer.render(simScene, cam);
        const tmp = rtA; rtA = rtB; rtB = tmp;
        clickForce *= 0.72;
        framePrev.copy(mouse);
        dispMat.uniforms.u_height.value = rtA.texture;
        dispMat.uniforms.u_time.value = clock.getElapsedTime();
        renderer.setRenderTarget(null);
        renderer.render(dispScene, cam);
        raf = requestAnimationFrame(frame);
      };
      frame();

      cleanup.push(() => {
        cancelAnimationFrame(raf);
        rtA && rtA.dispose(); rtB && rtB.dispose();
        geo.dispose(); simMat.dispose(); dispMat.dispose(); renderer?.dispose();
      });
    } catch (err) { console.error("WebGL init failed:", err); }

    return () => { cleanup.forEach((f) => f()); };
  }, []);

  const font = "var(--font-montserrat), 'Century Gothic', 'Futura', system-ui, sans-serif";
  const sh = "0 2px 26px rgba(0,10,22,.9), 0 1px 3px rgba(0,10,22,.7)";

  return (
    <div style={{ position: "relative", width: "100%", minHeight: "100vh", overflow: "hidden", background: "linear-gradient(180deg,#0b3550,#06243a 55%,#03121f)", color: "#eaf7ff", fontFamily: font }}>
      <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", display: "block", zIndex: 0 }} />

      <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none",
        background: `linear-gradient(100deg, rgba(1,14,26,${SCRIM}) 0%, rgba(1,14,26,${SCRIM * 0.5}) 30%, rgba(1,14,26,0) 58%), linear-gradient(to top, rgba(1,14,26,0.4) 0%, rgba(1,14,26,0) 24%)` }} />

      <div style={{ position: "relative", zIndex: 2, pointerEvents: "none", minHeight: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "clamp(1.6rem, 5vw, 4rem)" }}>
        <div style={{ maxWidth: "60%" }}>
          <svg width="42" height="42" viewBox="0 0 42 42" style={{ marginBottom: "1.6rem", filter: "drop-shadow(0 2px 12px rgba(0,10,22,.8))" }}>
            <rect x="1.5" y="1.5" width="39" height="39" rx="7" fill="none" stroke="#eaf7ff" strokeWidth="2.4" />
            <path d="M13 29 L13 13 L23 13 Q30 13 30 20 Q30 26 23 26 L18 26" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <div style={{ fontWeight: 300, letterSpacing: "0.14em", lineHeight: 1.12, fontSize: "clamp(1.6rem, 3.6vw, 3rem)", textShadow: sh }}>
            {CONFIG.availability.map((l) => <div key={l}>{l}</div>)}
          </div>
          <div style={{ marginTop: ".55rem", fontWeight: 300, letterSpacing: "0.32em", fontSize: "clamp(.7rem,1.4vw,1rem)", opacity: 0.92, textShadow: sh }}>{CONFIG.availabilitySub}</div>
        </div>

        <div style={{ maxWidth: "62%", marginTop: "auto", marginBottom: "auto" }}>
          <h1 style={{ margin: 0, fontWeight: 300, letterSpacing: "0.02em", lineHeight: 0.95, fontSize: "clamp(3rem, 12.5vw, 11rem)", whiteSpace: "nowrap", textShadow: "0 6px 50px rgba(0,10,22,.85)" }}>
            <span style={{ color: "#eaf7ff" }}>{CONFIG.bigWord.slice(0, 4)}</span>
            <span style={{ background: "linear-gradient(90deg,#eaf7ff,#9fe6ff 55%,#4fccf5)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent" }}>{CONFIG.bigWord.slice(4)}</span>
          </h1>
          <div style={{ marginTop: "clamp(1rem,2.4vw,2rem)", textShadow: sh }}>
            <div style={{ fontWeight: 700, letterSpacing: "0.08em", fontSize: "clamp(1rem,2vw,1.6rem)" }}>{CONFIG.name}</div>
            <div style={{ marginTop: ".45rem", letterSpacing: "0.06em", fontSize: "clamp(.8rem,1.4vw,1.1rem)", opacity: 0.92 }}>
              <b style={{ fontWeight: 700 }}>{CONFIG.title.split(" ")[0]} </b>{CONFIG.title.split(" ").slice(1).join(" ")}
            </div>
            <div style={{ marginTop: ".3rem", fontWeight: 700, letterSpacing: "0.06em", fontSize: "clamp(.8rem,1.4vw,1.1rem)" }}>{CONFIG.years}</div>
          </div>
        </div>

        <div style={{ maxWidth: "60%", fontWeight: 500, lineHeight: 1.5, letterSpacing: "0.01em", fontSize: "clamp(.85rem,1.6vw,1.15rem)", textShadow: sh }}>
          {CONFIG.tagline.map((l) => <div key={l}>{l}</div>)}
        </div>
      </div>

      <div style={{ position: "absolute", right: "clamp(1rem, 5vw, 6rem)", bottom: 0, zIndex: 2, height: "clamp(48vh, 62vh, 92vh)", aspectRatio: "3 / 4", display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}>
        {imgOk ? (
          <img src={CONFIG.photo} alt="portrait" onError={() => setImgOk(false)} style={{ height: "100%", width: "100%", objectFit: "contain", filter: "grayscale(100%) contrast(1.05)" }} />
        ) : (
          <div style={{ height: "80%", width: "78%", borderRadius: 18, border: "1px solid rgba(234,247,255,0.32)", background: "linear-gradient(180deg, rgba(234,247,255,0.12), rgba(234,247,255,0.03))", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
            <svg width="96" height="120" viewBox="0 0 96 120" fill="none" stroke="rgba(234,247,255,0.55)" strokeWidth="2.4">
              <circle cx="48" cy="30" r="17" />
              <path d="M30 47 q18 12 36 0 l6 26 h-12 l-4 21 h-16 l-4 -21 h-12 z" strokeLinejoin="round" />
            </svg>
            <div style={{ fontFamily: font, fontWeight: 300, letterSpacing: "0.18em", fontSize: ".72rem", opacity: 0.8, textAlign: "center" }}>
              YOUR PHOTO<br /><span style={{ opacity: 0.7 }}>public/portrait.png</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
