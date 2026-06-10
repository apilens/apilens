import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconOnly?: boolean;
}

/** Aperture <Button> — the one button. Replaces the .settings-btn* / .auth-*-btn sprawl. */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", iconOnly = false, className = "", type = "button", ...rest },
  ref,
) {
  const classes = [
    "ap-btn",
    `ap-btn-${variant}`,
    size !== "md" ? `ap-btn-${size}` : "",
    iconOnly ? "ap-btn-icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button ref={ref} type={type} className={classes} {...rest} />;
});

export default Button;
