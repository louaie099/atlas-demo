import { Card } from "./ui";

export function KpiCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneColor = {
    neutral: "text-ink",
    good: "text-good-700",
    warn: "text-warn-700",
    bad: "text-bad-700",
  }[tone];

  return (
    <Card className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className={`font-mono text-[34px] leading-none font-semibold ${toneColor}`}>{value}</span>
      {sub && <span className="text-[13px] text-muted">{sub}</span>}
    </Card>
  );
}
