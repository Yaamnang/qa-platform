"use client";

import { useState, type ComponentProps } from "react";
import { EyeIcon, EyeOffIcon } from "./icons";
import { Field } from "./ui";

type Props = Omit<ComponentProps<typeof Field>, "type" | "addon"> & {
  /** Pass these two to control show/hide from outside (e.g. after "Generate"). */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
};

/**
 * A password field with an eye button that shows or hides what was typed.
 * Hidden by default. The button is named "Show password" / "Hide password"
 * (using the field's label), so screen readers and the QA robot can find it.
 */
export function PasswordField({ revealed, onRevealedChange, label, id, ...rest }: Props) {
  const [ownRevealed, setOwnRevealed] = useState(false);
  const shown = revealed ?? ownRevealed;
  const setShown = onRevealedChange ?? setOwnRevealed;
  const action = `${shown ? "Hide" : "Show"} ${label.toLowerCase()}`;

  return (
    <Field
      {...rest}
      id={id}
      label={label}
      type={shown ? "text" : "password"}
      // Browsers should not offer to fix the spelling of a visible password.
      spellCheck={false}
      autoCapitalize="off"
      addon={
        <button type="button" onClick={() => setShown(!shown)} aria-label={action} title={action} aria-controls={id}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-ink-400 hover:text-ink-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500">
          {shown ? <EyeOffIcon className="size-[18px]" /> : <EyeIcon className="size-[18px]" />}
        </button>
      }
    />
  );
}
