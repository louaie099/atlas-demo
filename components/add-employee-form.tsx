"use client";

import { useState } from "react";
import { Button } from "./ui";
import { EmployeeProfileForm } from "./employee-profile-form";
import { useRole } from "./role-context";
import { canManageEmployees } from "@/lib/roles";

export function AddEmployeeForm({ onAdded }: { onAdded: () => void }) {
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const allowed = canManageEmployees(role);

  return (
    <>
      <span title={allowed ? undefined : "Administrator permission required to add employees"}>
        <Button onClick={() => allowed && setOpen(true)} disabled={!allowed} className="self-start">
          + Add Employee
        </Button>
      </span>
      {open && <EmployeeProfileForm mode="create" onClose={() => setOpen(false)} onSaved={onAdded} />}
    </>
  );
}
