import * as React from "react";

import { cn } from "../../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => {
    return <input type={type} className={cn("rem-input", className)} ref={ref} {...props} />;
  },
);

Input.displayName = "Input";

export { Input };
