"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AmbienceToggle from "./AmbienceToggle";
import { hasWebGL, RippleWater, type UvRect } from "./water/rippleWater";
import { heroFallbackFilter } from "./water/shaders";

const CONFIG = {
  availability: ["AVAILABLE", "FOR HIRE"],
  availabilitySub: "REMOTELY",
  bigWord: "PORTFOLIO",
  name: "AHMAD RAZA",
  title: "JR.FRONTEND DEVELOPER",
  years: "1.5 YEARS",
  tagline: [
    "Selected work across branding, digital,",
    "print, and visual communication.",
  ],
  photo: "/portrait.png",
};

/* ---- tune these ---- */
const LIGHT_X = 0.62; // sun position across the surface (keeps left readable)
const SCRIM = 0.42;

/** The scrim the CSS overlay paints, as an inline style. Used by the fallback. */
const SCRIM_CSS =
  `linear-gradient(100deg, rgba(1,14,26,${SCRIM}) 0%, rgba(1,14,26,${SCRIM * 0.5}) 30%, rgba(1,14,26,0) 58%),` +
  ` linear-gradient(to top, rgba(1,14,26,0.4) 0%, rgba(1,14,26,0) 24%)`;

type Mode = "probing" | "webgl" | "fallback";

export default function OceanPortfolio() {
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const portraitRef = useRef<HTMLImageElement | null>(null);
  const waterRef = useRef<RippleWater | null>(null);
  /* Read inside the measuring callback so it can stay identity-stable — it is
     a dependency of the effect that owns the GL context, and rebuilding that
     context because a boolean flipped would be an expensive mistake. */
  const imgOkRef = useRef(true);

  const [imgOk, setImgOk] = useState(true);
  const [mode, setMode] = useState<Mode>("probing");
  /* The DOM <img> keeps painting until the same pixels exist on the GPU, so the
     portrait never blinks out during the handover. */
  const [portraitInGL, setPortraitInGL] = useState(false);

  /* ---- measure the hero image for the shader --------------------------- */

  // The water draws the portrait itself so the ripples can bend it, but CSS
  // stays the source of truth for where it goes. Two rects are needed: the
  // element box (which the portrait-blend mask is relative to) and the smaller
  // box object-contain actually paints into.
  const syncPortraitRect = useCallback(() => {
    const water = waterRef.current;
    const img = portraitRef.current;
    if (!water) return;
    if (!img || !imgOkRef.current || !img.naturalWidth) {
      water.setPortraitRect(null, null);
      return;
    }

    const r = img.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!r.width || !r.height || !vw || !vh) return;

    const natural = img.naturalWidth / img.naturalHeight;
    const boxAspect = r.width / r.height;
    let dw = r.width;
    let dh = r.height;
    if (natural > boxAspect) dh = r.width / natural;
    else dw = r.height * natural;
    const dx = r.left + (r.width - dw) / 2; // object-position defaults to centre
    const dy = r.top + (r.height - dh) / 2;

    const toUv = (x: number, y: number, w: number, h: number): UvRect => ({
      x0: x / vw,
      y0: 1 - (y + h) / vh,
      x1: (x + w) / vw,
      y1: 1 - y / vh,
    });

    water.setPortraitRect(
      toUv(r.left, r.top, r.width, r.height),
      toUv(dx, dy, dw, dh),
    );
  }, []);

  /* ---- the water ------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!hasWebGL()) {
      setMode("fallback");
      return;
    }

    // A fresh canvas per mount. Reusing one across StrictMode's double-invoke
    // would hand the second renderer a context the first one already lost.
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;display:block";
    host.appendChild(canvas);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let water: RippleWater;
    try {
      water = new RippleWater(canvas, {
        portraitUrl: CONFIG.photo,
        lightX: LIGHT_X,
        scrim: SCRIM,
        reducedMotion: mq.matches,
        onPortraitReady: () => setPortraitInGL(true),
      });
    } catch (err) {
      console.warn("WebGL water unavailable, using the flat fallback:", err);
      canvas.remove();
      setMode("fallback");
      return;
    }

    waterRef.current = water;
    setMode("webgl");
    syncPortraitRect();
    water.start();

    /* --- keep the surface in step with the page --- */

    // Both paths coalesce into one frame, but the flag is tracked separately
    // from the handle: a scroll arriving in the same frame as a resize must not
    // swallow the resize, which is what a single shared guard would do.
    let rafSync = 0;
    let needsResize = false;
    const flush = () => {
      rafSync = 0;
      if (needsResize) {
        needsResize = false;
        water.resize();
      }
      syncPortraitRect();
    };
    const schedule = (resize: boolean) => {
      if (resize) needsResize = true;
      if (!rafSync) rafSync = requestAnimationFrame(flush);
    };

    const scheduleSync = () => schedule(true);
    // The canvas is fixed and the portrait is not, so scrolling moves one
    // relative to the other. Re-measuring is enough; no reallocation needed.
    const onScroll = () => schedule(false);

    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);
    window.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(scheduleSync);
    ro.observe(host);
    if (portraitRef.current) ro.observe(portraitRef.current);

    /* --- pause when nobody can see it --- */

    const onVisibility = () => water.setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();

    // Watch the section, not the canvas: the canvas is fixed and therefore
    // always "on screen", so it could never report itself out of view.
    const io = new IntersectionObserver(
      ([entry]) => water.setInView(entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(sectionRef.current ?? host);

    /* --- follow the motion preference live --- */

    const onMotionPref = (e: MediaQueryListEvent) =>
      water.setReducedMotion(e.matches);
    mq.addEventListener("change", onMotionPref);

    return () => {
      cancelAnimationFrame(rafSync);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMotionPref);
      ro.disconnect();
      io.disconnect();
      water.dispose();
      waterRef.current = null;
      canvas.remove();
      setPortraitInGL(false);
    };
  }, [syncPortraitRect]);

  // The layout can settle after the effect runs (fonts, the image decoding),
  // so re-measure whenever anything that moves the portrait changes.
  useEffect(() => {
    imgOkRef.current = imgOk;
    syncPortraitRect();
  }, [syncPortraitRect, imgOk, mode]);

  const glActive = mode === "webgl";
  const glOwnsPortrait = glActive && portraitInGL && imgOk;

  // only the seniority prefix ("JR", "SR") is bold — everything from the dot on
  // stays regular weight
  const dot = CONFIG.title.indexOf(".");
  const titleLead = dot > 0 ? CONFIG.title.slice(0, dot) : CONFIG.title;
  const titleRest = dot > 0 ? CONFIG.title.slice(dot) : "";

  return (
    <div
      ref={sectionRef}
      className="relative min-h-screen w-full overflow-hidden bg-[linear-gradient(180deg,#0b3550,#06243a_55%,#03121f)] font-sans text-foam"
    >
      <div ref={hostRef} className="fixed inset-0 z-0" />

      {/* Without WebGL the water is a still gradient, so the readability scrim
          has to come back as an overlay. With WebGL the ocean pass paints it,
          which is what lets the portrait sit above it and still be refracted. */}
      {!glActive && (
        <div
          className="pointer-events-none fixed inset-0 z-[1]"
          style={{ background: SCRIM_CSS }}
        />
      )}

      <div className="pointer-events-none relative z-[2] flex min-h-screen flex-col justify-between p-[clamp(1.6rem,5vw,4rem)]">
        <div className="max-w-[60%]">
          <svg
            width="42"
            height="42"
            viewBox="0 0 42 42"
            className="mb-[1.6rem] drop-shadow-[0_2px_12px_rgba(0,10,22,.8)]"
          >
            <rect
              x="1.5"
              y="1.5"
              width="39"
              height="39"
              rx="7"
              fill="none"
              stroke="#eaf7ff"
              strokeWidth="2.4"
            />
            <path
              d="M13 29 L13 13 L23 13 Q30 13 30 20 Q30 26 23 26 L18 26"
              fill="none"
              stroke="#fff"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <div className="text-shadow-deep text-[clamp(1.6rem,3.6vw,3rem)] font-light leading-[1.12] tracking-[0.14em]">
            {CONFIG.availability.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
          <div className="text-shadow-deep mt-[.55rem] text-[clamp(.7rem,1.4vw,1rem)] font-light tracking-[0.32em] opacity-[0.92]">
            {CONFIG.availabilitySub}
          </div>
        </div>

        <div className="my-auto max-w-[62%]">
          <h1 className="text-shadow-title m-0 whitespace-nowrap text-[clamp(3rem,12.5vw,11rem)] font-light leading-[0.95] tracking-[0.02em]">
            <span className="text-foam">{CONFIG.bigWord.slice(0, 4)}</span>
            <span className="bg-[linear-gradient(90deg,#eaf7ff,#9fe6ff_55%,#4fccf5)] bg-clip-text text-transparent [-webkit-text-fill-color:transparent]">
              {CONFIG.bigWord.slice(4)}
            </span>
          </h1>
          <div className="text-shadow-deep mt-[clamp(1rem,2.4vw,2rem)]">
            <div className="text-[clamp(1rem,2vw,1.6rem)] font-bold tracking-[0.08em]">
              {CONFIG.name}
            </div>
            <div className="mt-[.45rem] text-[clamp(.8rem,1.4vw,1.1rem)] tracking-[0.06em] opacity-[0.92]">
              <b className="font-bold">{titleLead}</b>
              {titleRest}
            </div>
            <div className="mt-[.3rem] text-[clamp(.8rem,1.4vw,1.1rem)] font-bold tracking-[0.06em]">
              {CONFIG.years}
            </div>
          </div>
        </div>

        <div className="text-shadow-deep max-w-[60%] text-[clamp(.85rem,1.6vw,1.15rem)] font-medium leading-[1.5] tracking-[0.01em]">
          {CONFIG.tagline.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-0 right-[clamp(1rem,5vw,6rem)] z-[2] flex aspect-[3/4] h-[clamp(48vh,62vh,92vh)] items-end justify-center">
        {imgOk ? (
          /* The photo is already colour-graded for this scene (caustics, teal
             cast), so it keeps its colour — a grayscale filter here would throw
             that away. portrait-blend feathers the opaque rectangle into the
             water.

             When the water is running this element is only a measuring stick:
             it holds the layout, and the shader reads its box and draws the
             same pixels underneath the surface, where the ripples can bend
             them. It stays visible until the texture is on the GPU. */
          <img
            ref={portraitRef}
            src={CONFIG.photo}
            alt={CONFIG.name}
            onLoad={syncPortraitRect}
            onError={() => setImgOk(false)}
            aria-hidden={glOwnsPortrait || undefined}
            className="portrait-blend h-full w-full object-contain"
            /* The grade lives in one place (HERO_GRADE) and is applied by the
               shader when the water runs. This mirrors it for the fallback, so
               the photo is lifted out of the dark either way. Written inline
               rather than as filter utilities because a Tailwind filter class
               and an inline filter cannot both apply. */
            style={
              glOwnsPortrait
                ? { opacity: 0 }
                : { filter: heroFallbackFilter }
            }
          />
        ) : (
          <div className="flex h-[80%] w-[78%] flex-col items-center justify-center gap-[14px] rounded-[18px] border border-[rgba(234,247,255,0.32)] bg-[linear-gradient(180deg,rgba(234,247,255,0.12),rgba(234,247,255,0.03))] backdrop-blur-[6px]">
            <svg
              width="96"
              height="120"
              viewBox="0 0 96 120"
              fill="none"
              stroke="rgba(234,247,255,0.55)"
              strokeWidth="2.4"
            >
              <circle cx="48" cy="30" r="17" />
              <path
                d="M30 47 q18 12 36 0 l6 26 h-12 l-4 21 h-16 l-4 -21 h-12 z"
                strokeLinejoin="round"
              />
            </svg>
            <div className="text-center font-sans text-[.72rem] font-light tracking-[0.18em] opacity-80">
              YOUR PHOTO
              <br />
              <span className="opacity-70">public/portrait.png</span>
            </div>
          </div>
        )}
      </div>

      {mode === "fallback" && <FallbackRipples />}

      <AmbienceToggle />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   No WebGL (or no float render targets): fall back to the flat CSS ripple this
   replaces. It cannot refract anything, but a tap still gets an acknowledgement
   and nothing crashes.
--------------------------------------------------------------------------- */

interface Splash {
  id: number;
  x: number;
  y: number;
}

function FallbackRipples() {
  const [splashes, setSplashes] = useState<Splash[]>([]);
  const next = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const onDown = (e: PointerEvent) => {
      const id = next.current++;
      setSplashes((s) => [...s.slice(-5), { id, x: e.clientX, y: e.clientY }]);
      window.setTimeout(
        () => setSplashes((s) => s.filter((r) => r.id !== id)),
        1400,
      );
    };
    window.addEventListener("pointerdown", onDown, { passive: true });
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[3] overflow-hidden">
      {splashes.map((s) => (
        <span
          key={s.id}
          className="water-splash"
          style={{ left: s.x, top: s.y }}
        />
      ))}
    </div>
  );
}
