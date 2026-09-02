import { Employee } from "@/lib/types";

export function QualificationMatrix({ employees }: { employees: Employee[] }) {
  const skillColumns = Array.from(new Set(employees.flatMap((e) => e.skills))).sort();
  const companyColumns = Array.from(new Set(employees.flatMap((e) => e.foreign_company_authorizations))).sort();

  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-auto max-h-[70vh]">
      <table className="text-sm border-collapse">
        <thead className="sticky top-0 bg-white z-10">
          <tr>
            <th className="sticky left-0 bg-white z-20 text-left px-4 py-3 border-b border-r border-border whitespace-nowrap">
              Employee
            </th>
            {skillColumns.map((s) => (
              <th key={s} className="px-3 py-3 border-b border-border text-xs text-muted whitespace-nowrap font-medium">
                {s}
              </th>
            ))}
            {companyColumns.map((c) => (
              <th
                key={c}
                className="px-3 py-3 border-b border-border text-xs text-brand-700 whitespace-nowrap font-medium bg-brand-50/40"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.id} className="border-b border-border last:border-0">
              <td className="sticky left-0 bg-white z-10 px-4 py-2 font-medium text-ink whitespace-nowrap border-r border-border">
                {e.name}
              </td>
              {skillColumns.map((s) => (
                <td key={s} className="px-3 py-2 text-center">
                  {e.skills.includes(s) ? <span className="text-good-700">✓</span> : <span className="text-gray-200">·</span>}
                </td>
              ))}
              {companyColumns.map((c) => (
                <td key={c} className="px-3 py-2 text-center bg-brand-50/20">
                  {e.foreign_company_authorizations.includes(c) ? (
                    <span className="text-brand-700">✓</span>
                  ) : (
                    <span className="text-gray-200">·</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
