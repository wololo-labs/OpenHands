import type { ReactNode } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  /**
   * Optional content rendered before the label in both the trigger
   * (when this option is selected) and each menu row. Used for things
   * like status indicators; not searchable.
   */
  prefix?: ReactNode;
  /**
   * Renders the row but refuses selection (keyboard and pointer). Used for
   * options that exist but are not connectable yet, such as a fleet backend
   * still waiting for approval.
   */
  disabled?: boolean;
}
