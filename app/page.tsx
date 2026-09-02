"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RosterRequirementView } from "@/lib/types";
import { KpiCard } from "@/components/kpi-card";
import { Card, Badge } from "@/components/ui";

export default function DashboardPage() {
  const [roster, setRoster] = useState<RosterRequirementView[] | null>(null);

  useEffect(() => {
    fetch("/api/roster")
      .then((r) => r.json())
      .then((data) => setRoster(data.roster ?? []));
  }, []);

  const openIssues = roster?.filter((v) => v.coverageStatus === "gap" || v.coverageStatus === "needs_configuration") ?? [];
  const forecastDriven = roster?.filter((v) => v.requirement.source === "demand_forecast") ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Operations Overview</h1>
        <p className="text-muted mt-1">Casablanca Mohammed V (CMN) · Wednesday</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Open Staffing Gaps" value={roster ? openIssues.length : "…"} tone={openIssues.length > 0 ? "warn" : "good"} />
        <KpiCard label="Flights Tracked" value={roster ? new Set(roster.map((v) => v.flight.id)).size : "…"} />
        <KpiCard label="Planning-Forecast Requirements" value={roster ? forecastDriven.length : "…"} tone="warn" />
        <KpiCard label="Active Alerts" value={0} tone="good" />
      </div>

      <div>
        <h2 className="text-lg font-semibold text-ink mb-3">Current Staffing Gaps</h2>
        {openIssues.length === 0 && roster && (
          <Card>
            <p className="text-sm text-muted">No open staffing gaps right now.</p>
          </Card>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          {openIssues.map((v) => (
            <Link key={v.requirement.id} href="/planning">
              <Card className="hover:shadow-softer cursor-pointer">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">
                    {v.flight.flight_number} · {v.requirement.role}
                  </span>
                  <Badge tone="bad">
                    {v.coverageStatus === "needs_configuration"
                      ? "Needs Configuration"
                      : `${v.assignedEmployees.length}/${v.requirement.total_requirement}`}
                  </Badge>
                </div>
                <p className="text-sm text-muted mt-2">{v.requirement.reasoning}</p>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">
        <Link href="/planning" className="text-sm font-medium text-brand-600 hover:underline">
          Go to Weekly Planning →
        </Link>
        <Link href="/operations" className="text-sm font-medium text-brand-600 hover:underline">
          Go to Live Operations →
        </Link>
      </div>
    </div>
  );
}
