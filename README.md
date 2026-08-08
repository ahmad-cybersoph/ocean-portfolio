# Ocean Portfolio

Animated underwater portfolio hero built with **Next.js (App Router) + TypeScript + Three.js**.
Real-time water: god-ray sunlight, a sandy seabed with caustics, rising bubbles, and an
interactive ripple simulation that reacts to the cursor.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Customise

- **Text**: edit the `CONFIG` object at the top of `components/OceanPortfolio.tsx`
  (name, title, years, tagline, availability).
- **Your photo**: drop `portrait.png` into `public/` (transparent PNG recommended).
- **Look & feel**: the tunable constants live at the top of `OceanPortfolio.tsx`:
  - `DAMPING` — how long ripples last
  - `NORMAL_STRENGTH`, `REFRACT` — ripple distortion strength
  - `LIGHT_X` — horizontal position of the sunlight column
  - `SCRIM` — darkness of the scrim behind the left text (readability)
  - `SIM_MAX` — simulation resolution (lower = faster on weak GPUs)
- Bubble behaviour and the seabed live inside the `dispFrag` shader
  (`interactiveBubbles`, `seabed`) and the pointer handlers.

## Notes

- The whole effect is a client component (`"use client"`).
- Uses WebGL2 half-float render targets; falls back to a CSS gradient if WebGL fails.
- Montserrat is loaded via `next/font/google` in `app/layout.tsx`.
- If the display shader feels heavy on an older device, lower `SIM_MAX` to ~560 and
  change `renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))` to `1.5`.

## Deploy (Vercel)

```bash
npm i -g vercel
vercel
```

Or push to GitHub and import the repo at vercel.com — zero config needed.
