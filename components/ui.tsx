import { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-card border border-border rounded-xl2 shadow-soft p-5 ${className}`}>
      {children}
    </div>
  );
}

/** Standard page title block: consistent across every screen (Command Center redesign). */
export function PageHeader({
  title,
  subtitle,
  actions,
  badge,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight text-ink">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="text-[15px] text-muted mt-1.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3 flex-wrap">{actions}</div>}
    </header>
  );
}

type BadgeTone = "brand" | "good" | "warn" | "bad" | "neutral";

const badgeTones: Record<BadgeTone, string> = {
  brand: "bg-brand-50 text-brand-700",
  good: "bg-good-50 text-good-700",
  warn: "bg-warn-50 text-warn-700",
  bad: "bg-bad-50 text-bad-700",
  neutral: "bg-gray-100 text-gray-700",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${badgeTones[tone]}`}>
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "bg-white text-ink border border-border hover:bg-gray-50",
  danger: "bg-bad-500 text-white hover:bg-bad-700",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-gray-100",
};

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg text-sm font-medium shadow-soft disabled:opacity-50 disabled:cursor-not-allowed ${buttonVariants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
