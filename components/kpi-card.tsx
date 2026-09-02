import { Card } from "./ui";

export function KpiCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneColor = {
    neutral: "text-ink",
    good: "text-good-700",
    warn: "text-warn-700",
    bad: "text-bad-700",
  }[tone];

  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-3xl font-semibold ${toneColor}`}>{value}</span>
    </Card>
  );
}
