import { CheckIcon, ImageIcon } from "lucide-react";

import { LogoMark } from "@/components/hf/logo";

/**
 * The right half of the sign-in page: what the product does, shown rather
 * than told — a request from a website becoming a quote the owner approves.
 * Static, so it costs nothing on a phone that never sees it.
 */
export function BrandPanel({ tagline, line }: { tagline: string; line: string }) {
  return (
    <div className="bg-fjord text-fjord-foreground relative flex h-full flex-col justify-between overflow-hidden p-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
          backgroundSize: "4px 4px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, oklch(0.75 0.1 80), transparent 65%)" }}
      />

      <div className="relative flex items-center gap-2.5">
        <LogoMark className="size-8 [&_rect]:fill-fjord-foreground/10" />
        <span className="font-serif text-2xl">Humanframe</span>
      </div>

      <div className="relative mx-auto w-full max-w-[420px]">
        <div className="bg-card text-card-foreground shadow-lift rotate-[-1.5deg] rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase">Fra nettsiden</span>
            <span className="text-muted-foreground text-xs">2 min siden</span>
          </div>
          <p className="mt-3 font-serif text-2xl leading-tight">Lekkasje under kjøkkenvask</p>
          <p className="text-muted-foreground mt-1 text-sm">Kari Nordmann · Storgata 12, Bergen</p>
          <div className="mt-4 flex gap-2">
            {[0, 1, 2].map((index) => (
              <span key={index} className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-lg">
                <ImageIcon className="size-4" />
              </span>
            ))}
          </div>
        </div>
        <div className="bg-card text-card-foreground shadow-lift relative mt-[-10px] ml-10 rotate-[1deg] rounded-2xl p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Tilbud 14</span>
            <span className="font-serif tabular text-2xl">4 850 kr</span>
          </div>
          <div className="text-muted-foreground mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between"><span>Feilsøking, 2 timer</span><span className="tabular">1 900</span></div>
            <div className="flex justify-between"><span>Nytt blandebatteri</span><span className="tabular">2 260</span></div>
            <div className="flex justify-between"><span>Oppmøte</span><span className="tabular">690</span></div>
          </div>
          <div className="bg-fjord text-fjord-foreground mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium">
            <CheckIcon className="size-4" /> Godkjenn og send
          </div>
        </div>
      </div>

      <div className="relative max-w-[440px]">
        <p className="font-serif text-[2.6rem] leading-[1.05] tracking-[-0.02em]">{tagline}</p>
        <p className="text-fjord-foreground/70 mt-3 text-[15px] leading-relaxed">{line}</p>
      </div>
    </div>
  );
}
