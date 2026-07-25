import Image from "next/image";

interface LogoProps {
  /** Tailwind size classes for the wrapping box, e.g. "h-10 w-10". Caller controls sizing/responsiveness. */
  className?: string;
}

/** Jersey Premier League crest. Wraps `next/image` with `fill` — the parent box must be `relative`-positioned and sized. */
export function Logo({ className = "h-10 w-10" }: LogoProps) {
  return (
    <div className={`relative shrink-0 ${className}`}>
      <Image src="/logo.png" alt="Jersey Premier League" fill sizes="48px" className="object-contain" />
    </div>
  );
}
