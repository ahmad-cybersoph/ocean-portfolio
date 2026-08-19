/* ---------------------------------------------------------------------------
   GLSL for the water. Three passes, run once per frame:

     1. sim       — a height-field wave equation on a ping-ponged float target.
                    This is what makes ripples interfere, reflect and decay
                    instead of being a canned animation.
     2. ocean     — the underwater scene (gradient, seabed, caustics, god rays,
                    bubbles, readability scrim). Rendered a little below display
                    resolution because everything in it is soft; the refraction
                    pass hides the difference.
     3. composite — reads the wave height, turns it into a surface normal, and
                    bends the ocean texture and the hero portrait through it.
                    This is the pass that makes the water look like water: the
                    pixels underneath actually move.

   A drop pass runs on demand between 1 and 2 to stamp new ripples in.
--------------------------------------------------------------------------- */

export const MAX_DROPS = 8;
export const MAX_BUBBLES = 40;

/* ---- hero photo grade -----------------------------------------------------
   portrait.png is a dark image: mean luminance is 61.6/255, about 24%, and the
   contrast bump below pushes its shadows down further still. These lift it.

   `lift` is a gamma: below 1 it raises shadows and midtones and leaves white
   alone, which is what a dark photo wants. A straight multiply big enough to
   do the same job would flatten the highlights on the face first. `brightness`
   then does the last bit as a plain multiply.

   Order matters and is shared with the CSS fallback: lift, brightness,
   saturate, contrast. Saturate and contrast are both affine so they commute
   with each other, but brightness does not commute with contrast — swapping
   those two changes the result.
--------------------------------------------------------------------------- */
export const HERO_GRADE = {
  lift: 0.8, // gamma; <1 brightens
  brightness: 1.12,
  saturate: 1.06, // from the original CSS
  contrast: 1.05, // from the original CSS
};

/* Tone the CSS fallback is matched at. Not the mean of the whole file (0.242)
   — that average is dragged down by the feathered edges, which are water. This
   is the mean over the subject, the part anyone actually looks at, so the two
   paths agree on the face rather than on the corners. */
const HERO_ANCHOR_TONE = 0.34;

/* CSS has no gamma filter, so the no-WebGL path folds the lift into the
   multiply that meets the shader's curve at the anchor tone. Flatter in the
   deep shadows and the highlights, the same where it counts. */
export const heroFallbackFilter = [
  `brightness(${(
    (Math.pow(HERO_ANCHOR_TONE, HERO_GRADE.lift) * HERO_GRADE.brightness) /
    HERO_ANCHOR_TONE
  ).toFixed(3)})`,
  `saturate(${HERO_GRADE.saturate})`,
  `contrast(${HERO_GRADE.contrast})`,
].join(" ");

/** Fullscreen quad. The geometry is already in clip space. */
export const VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* sRGB <-> linear. The renderer encodes to sRGB on output, so shader colour is
   linear-light. The scrim and the portrait have to be composited in sRGB to
   land on exactly the tone the CSS overlay and the <img> they replace did. */
const COLOR_SPACE = /* glsl */ `
  vec3 lin2srgb(vec3 c){
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 srgb2lin(vec3 c){
    c = max(c, vec3(0.0));
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
`;

/* ---------------------------------------------------------------------------
   1. Wave simulation.

   texel.r = height, texel.g = vertical velocity. Each step accelerates the
   velocity toward the average of the four neighbours (a discrete Laplacian,
   i.e. the wave equation), damps it, then integrates. Two ripples crossing
   simply add, which is the interference the CSS version could never produce.
--------------------------------------------------------------------------- */
export const SIM_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_prev;
  uniform vec2  u_texel;
  uniform float u_damping;
  uniform float u_tension;
  uniform float u_absorb;

  void main(){
    vec4 info = texture2D(u_prev, vUv);
    vec2 dx = vec2(u_texel.x, 0.0);
    vec2 dy = vec2(0.0, u_texel.y);

    float avg = (
        texture2D(u_prev, vUv - dx).r
      + texture2D(u_prev, vUv + dx).r
      + texture2D(u_prev, vUv - dy).r
      + texture2D(u_prev, vUv + dy).r
    ) * 0.25;

    info.g += (avg - info.r) * u_tension;
    info.g *= u_damping;
    info.r += info.g;

    // Soak up energy at the borders. Without this the clamped edge acts as a
    // perfect mirror and the screen slowly fills with standing waves.
    vec2 e = min(vUv, 1.0 - vUv);
    info.rg *= mix(u_absorb, 1.0, smoothstep(0.0, 0.07, min(e.x, e.y)));

    info.r = clamp(info.r, -2.0, 2.0);
    gl_FragColor = vec4(info.rg, 0.0, 1.0);
  }
`;

/* ---------------------------------------------------------------------------
   2. Drop stamping.

   Each drop is a capsule (a segment with a radius) so a fast pointer move lays
   down one continuous trail instead of a dotted line of separate splashes.
   The raised-cosine profile is the standard shape here: it has no corner at
   the rim, so what leaves it is a clean ring rather than a ringing artefact.
--------------------------------------------------------------------------- */
export const DROP_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D u_prev;
  uniform vec4  u_dropSeg[${MAX_DROPS}];   // x0, y0, x1, y1 (uv)
  uniform vec2  u_dropShape[${MAX_DROPS}]; // radius, strength
  uniform float u_dropCount;
  uniform float u_aspect;

  #define PI 3.14159265359

  float segDist(vec2 p, vec2 a, vec2 b){
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
    return length(pa - ba * h);
  }

  void main(){
    vec4 info = texture2D(u_prev, vUv);
    vec2 asp = vec2(u_aspect, 1.0);
    vec2 p = vUv * asp;

    for (int i = 0; i < ${MAX_DROPS}; i++) {
      if (float(i) >= u_dropCount) break;
      vec4 seg = u_dropSeg[i];
      vec2 sh  = u_dropShape[i];
      float d = segDist(p, seg.xy * asp, seg.zw * asp);
      float t = 1.0 - clamp(d / max(sh.x, 1e-5), 0.0, 1.0);
      info.r += (0.5 - cos(t * PI) * 0.5) * sh.y;
    }

    gl_FragColor = vec4(info.rg, 0.0, 1.0);
  }
`;

/* ---------------------------------------------------------------------------
   3. The underwater scene.

   Unchanged in spirit from the original single-pass shader — same seabed,
   caustics, god rays and bubbles — but with the refraction, the specular and
   the height shading taken out, because those now belong to the composite
   pass. The readability scrim moved in here so the portrait can sit above it
   and still be refracted along with everything else.
--------------------------------------------------------------------------- */
export const OCEAN_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float u_time;
  uniform float u_aspect;
  uniform float u_lightX;
  uniform float u_scrim;
  uniform vec2  u_resolution;
  uniform vec4  u_bubbles[${MAX_BUBBLES}];  // x, y, birth, size

  #define TAU 6.28318530718

  ${COLOR_SPACE}

  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec2  hash2(vec2 p){ vec3 a = fract(vec3(p.xyx) * vec3(123.34, 234.34, 345.65)); a += dot(a, a + 34.45); return fract(vec2(a.x * a.y, a.y * a.z)); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.0 + vec2(37, 17); a *= 0.5; } return v; }

  // caustic light network (seabed)
  float caustic(vec2 uv){
    float t = u_time * 0.4 + 23.0;
    vec2 p = mod(uv * TAU, TAU) - 250.0;
    vec2 i = p; float c = 1.0; float inten = 0.005;
    for (int n = 0; n < 5; n++){
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= 5.0; c = 1.17 - pow(c, 1.4);
    return 1.0 - exp(-pow(abs(c), 6.0) * 0.9);
  }

  // volumetric light shafts from a source near the top surface
  float godRays(vec2 uv, vec2 asp, vec2 lp){
    float ang = (uv.x - lp.x) / max(lp.y - uv.y, 0.06);
    float r = 0.0;
    r += smoothstep(0.20, 1.0, fbm(vec2(ang * 7.0, u_time * 0.10)));
    r += 0.55 * smoothstep(0.25, 1.0, fbm(vec2(ang * 13.0 - 5.0, u_time * 0.16)));
    r *= smoothstep(-0.1, 0.75, uv.y);
    r *= exp(-distance(uv * asp, lp * asp) * 1.05);
    return r;
  }

  // sparse rising bubbles
  float bubbles(vec2 uv, vec2 asp){
    float b = 0.0;
    for (int k = 0; k < 2; k++){
      float fk = float(k);
      vec2 g = uv * asp * (9.0 + fk * 7.0);
      g.y -= u_time * (0.35 + fk * 0.28);
      vec2 id = floor(g), f = fract(g);
      vec2 rnd = hash2(id);
      if (rnd.x > 0.86){
        vec2 c = vec2(0.2 + rnd.y * 0.6, 0.3 + fract(rnd.x * 7.0) * 0.4);
        float rad = 0.05 + rnd.y * 0.05;
        b += smoothstep(rad, rad * 0.25, length(f - c)) * 0.6;
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

    float dune   = fbm(fuv * vec2(1.6, 1.0));
    float ripple = fbm(fuv * vec2(2.0, 7.0) + vec2(0.0, u_time * 0.02));
    float relief = clamp(dune * 0.7 + ripple * 0.35, 0.0, 1.0);

    float ca = caustic(fuv * 1.1 + vec2(u_time * 0.02, 0.0));

    vec3 sand = mix(vec3(0.06, 0.16, 0.20), vec3(0.55, 0.72, 0.72), relief);
    sand += ca * vec3(0.55, 0.80, 0.85) * 0.9;

    float pool = exp(-abs(uv.x - u_lightX) * 2.2);
    sand *= 0.45 + 0.75 * pool;
    sand *= 0.35 + 0.65 * smoothstep(0.0, 0.22, below);

    float haze = smoothstep(0.0, 0.18, below);
    sand = mix(vec3(0.03, 0.16, 0.26), sand, haze);

    return vec4(sand, smoothstep(0.0, 0.06, below));
  }

  // interactive bubbles: thin bright rim + specular dot, rising and wobbling
  vec3 interactiveBubbles(vec2 uv, vec2 asp){
    vec3 acc = vec3(0.0);
    const float life = 3.6;
    for (int i = 0; i < ${MAX_BUBBLES}; i++) {
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
      float d = length(rel) / r;
      if (d > 1.3) continue;
      float rim = smoothstep(1.06, 0.92, d) - smoothstep(0.92, 0.72, d);
      vec2 ho = (rel / r) - vec2(-0.34, 0.34);
      float hi = exp(-dot(ho, ho) * 11.0);
      float fill = smoothstep(1.0, 0.5, d) * 0.05;
      acc += (vec3(0.75, 0.92, 1.0) * rim * 0.9 + vec3(1.0) * hi * 0.85 + vec3(0.5, 0.75, 0.85) * fill) * f;
    }
    return acc;
  }

  // Position along a CSS linear-gradient(<deg>) line, 0 at the first stop.
  float cssGradT(vec2 px, vec2 size, float deg){
    float a = radians(deg);
    vec2 dir = vec2(sin(a), -cos(a));                       // CSS y grows downward
    float len = abs(size.x * sin(a)) + abs(size.y * cos(a));
    return dot(px - size * 0.5, dir) / max(len, 1.0) + 0.5;
  }

  void main(){
    vec2 uv = vUv;
    vec2 asp = vec2(u_aspect, 1.0);
    vec2 lp = vec2(u_lightX, 1.15);

    float g = clamp(uv.y, 0.0, 1.0);
    vec3 col = mix(vec3(0.010, 0.055, 0.11), vec3(0.055, 0.26, 0.40), pow(g, 0.9));

    float sun = exp(-distance(uv * asp, lp * asp) * 1.7);
    col += vec3(0.10, 0.36, 0.52) * sun * 0.9;

    vec4 sb = seabed(uv, asp);
    col = mix(col, sb.rgb, sb.a);

    col += godRays(uv, asp, lp) * vec3(0.28, 0.58, 0.78) * 0.55;

    col += bubbles(uv, asp) * vec3(0.55, 0.78, 0.88) * 0.15;
    col += interactiveBubbles(uv, asp);

    vec2 vv = uv - 0.5;
    col *= 1.0 - 0.55 * dot(vv, vv * vec2(0.85, 1.05));
    col = pow(max(col, vec3(0.0)), vec3(1.03));

    // Readability scrim. The same two stacked gradients the DOM overlay used,
    // in the same order (the bottom fade paints first) and in sRGB space, so
    // the left-hand text sits on exactly the tone it did before.
    vec2 px = vec2(uv.x, 1.0 - uv.y) * u_resolution;
    vec3 scrimC = vec3(1.0, 14.0, 26.0) / 255.0;
    vec3 s = lin2srgb(col);
    s = mix(s, scrimC, 0.40 * (1.0 - clamp(uv.y / 0.24, 0.0, 1.0)));
    float t = clamp(cssGradT(px, u_resolution, 100.0), 0.0, 1.0);
    float a = t < 0.30 ? mix(u_scrim, u_scrim * 0.5, t / 0.30)
            : t < 0.58 ? mix(u_scrim * 0.5, 0.0, (t - 0.30) / 0.28)
            : 0.0;
    s = mix(s, scrimC, a);

    gl_FragColor = vec4(srgb2lin(s), 1.0);
  }
`;

/* ---------------------------------------------------------------------------
   4. Composite — the refraction.

   The wave height becomes a surface normal, the normal bends the lookup into
   the ocean texture and into the portrait, and the curvature of the surface
   brightens or dims what shows through, the way a real lens of water does.
   Red and blue bend by slightly different amounts, which is what stops the
   distortion from reading as a plain uv smear.
--------------------------------------------------------------------------- */
export const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D u_scene;
  uniform sampler2D u_sim;
  uniform sampler2D u_portrait;
  uniform vec2  u_simTexel;
  uniform vec4  u_portraitBox;   // element box in uv — drives the feather mask
  uniform vec4  u_portraitImg;   // object-contain box in uv — drives sampling
  uniform float u_hasPortrait;
  uniform float u_refract;
  uniform float u_slope;
  uniform float u_calm;
  uniform float u_specular;
  uniform float u_lens;
  uniform float u_time;

  ${COLOR_SPACE}

  void main(){
    vec2 uv = vUv;

    float h  = texture2D(u_sim, uv).r;
    float hl = texture2D(u_sim, uv - vec2(u_simTexel.x, 0.0)).r;
    float hr = texture2D(u_sim, uv + vec2(u_simTexel.x, 0.0)).r;
    float hd = texture2D(u_sim, uv - vec2(0.0, u_simTexel.y)).r;
    float hu = texture2D(u_sim, uv + vec2(0.0, u_simTexel.y)).r;

    // The sim grid matches the viewport aspect, so one x-texel and one y-texel
    // cover the same distance on screen: dividing both differences by the y
    // texel keeps the gradient isotropic and independent of sim resolution.
    vec2 grad = vec2(hr - hl, hu - hd) / (2.0 * u_simTexel.y);

    // A slow idle swell so the surface is never a dead flat mirror.
    vec2 calm = vec2(
      sin(uv.x * 12.0 + u_time * 0.52) + sin(uv.y *  8.0 - u_time * 0.37),
      cos(uv.y * 10.0 + u_time * 0.44) + sin(uv.x * 14.0 + u_time * 0.31)
    ) * u_calm;

    vec3 n = normalize(vec3(-(grad * u_slope + calm), 1.0));
    vec2 off = n.xy * u_refract;

    vec3 col;
    col.r = texture2D(u_scene, uv + off * 1.07).r;
    col.g = texture2D(u_scene, uv + off       ).g;
    col.b = texture2D(u_scene, uv + off * 0.93).b;

    // The portrait floats nearer the surface than the seabed does, so it bends
    // less. The small parallax between the two is most of what sells depth.
    if (u_hasPortrait > 0.5) {
      vec2 p = uv + off * 0.72;
      vec2 box = (p - u_portraitBox.xy) / max(u_portraitBox.zw - u_portraitBox.xy, vec2(1e-5));
      if (box.x > 0.0 && box.x < 1.0 && box.y > 0.0 && box.y < 1.0) {
        vec2 img = (p - u_portraitImg.xy) / max(u_portraitImg.zw - u_portraitImg.xy, vec2(1e-5));
        if (img.x > 0.0 && img.x < 1.0 && img.y > 0.0 && img.y < 1.0) {
          vec4 tex = texture2D(u_portrait, img);
          // portrait-blend, ported from CSS: top feather over the first 15% of
          // the box, side feathers over 16% at each edge, intersected.
          float mv = clamp((1.0 - box.y) / 0.15, 0.0, 1.0);
          float mh = min(clamp(box.x / 0.16, 0.0, 1.0), clamp((1.0 - box.x) / 0.16, 0.0, 1.0));
          float a = tex.a * mv * mh;
          if (a > 0.001) {
            vec3 pc = tex.rgb;                                   // display-referred
            // grade first, look second — see HERO_GRADE above
            pc = clamp(pow(max(pc, vec3(0.0)), vec3(${HERO_GRADE.lift.toFixed(4)}))
                       * ${HERO_GRADE.brightness.toFixed(4)}, vec3(0.0), vec3(1.0));
            pc = mix(vec3(dot(pc, vec3(0.213, 0.715, 0.072))), pc, ${HERO_GRADE.saturate.toFixed(4)});
            pc = (pc - 0.5) * ${HERO_GRADE.contrast.toFixed(4)} + 0.5;
            col = srgb2lin(mix(lin2srgb(col), clamp(pc, vec3(0.0), vec3(1.0)), a));
          }
        }
      }
    }

    // Glassy surface light, on top of everything because the surface is.
    vec3 H = normalize(normalize(vec3(-0.35, 0.72, 0.60)) + vec3(0.0, 0.0, 1.0));
    col += vec3(0.55, 0.82, 1.0) * pow(max(dot(n, H), 0.0), 96.0) * u_specular;
    // Grazing angles catch a little sky. A low exponent keeps this a wash of
    // light along the ring rather than a hard outline.
    col += vec3(0.22, 0.46, 0.66) * pow(1.0 - clamp(n.z, 0.0, 1.0), 1.35) * 0.6;

    // Curvature acts as a lens: crests gather light, troughs spread it. This is
    // what gives each ring its bright leading edge and dark inner band.
    float lap = (hl + hr + hu + hd - 4.0 * h) / max(u_simTexel.y * u_simTexel.y, 1e-9);
    col *= 1.0 + clamp(lap * u_lens, -0.30, 0.55);
    col *= 1.0 + clamp(h * 0.9, -0.14, 0.14);

    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }
`;
