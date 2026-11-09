"use client";

import { useState, type ComponentProps } from "react";
import { EyeIcon, EyeOffIcon } from "@/components/icons";
import { Field } from "@/components/ui";

type Props = Omit<ComponentProps<typeof Field>, "type" | "addon"> & { testId: string };

/**
 * A hidden input with a show/hide button, built on the shared Field.
 * Console-local instead of the shared PasswordField because every control in
 * the console carries a data-testid, and PasswordField's toggle has no way to take one.
 * The toggle's testid is the field's testid plus "-toggle".
 */
export function SecretField({ testId, label, id, ...rest }: Props) {
  const [shown, setShown] = useState(false);
  const action = `${shown ? "Hide" : "Show"} ${label.toLowerCase()}`;
  return (
    <Field
      {...rest}
      id={id}
      label={label}
      data-testid={testId}
      type={shown ? "text" : "password"}
      spellCheck={false}
      autoCapitalize="off"
      addon={
        <button type="button" onClick={() => setShown(!shown)} aria-label={action} title={action} aria-controls={id}
          data-testid={`${testId}-toggle`}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-ink-400 hover:text-ink-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500">
          {shown ? <EyeOffIcon className="size-[18px]" /> : <EyeIcon className="size-[18px]" />}
        </button>
      }
    />
  );
}
