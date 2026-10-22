import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

// Depth comes from the shadow tokens: an inset hairline, a top highlight and a
// bottom edge. That is what makes a control read as made, not generated.
// Sizes are dashboard-dense: 28 / 32 / 36px.
const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium",
    "transition duration-100 ease-out active:translate-y-px",
    "focus-ring disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-control-primary hover:bg-primary/90",
        secondary: "bg-card text-foreground shadow-control hover:bg-muted data-[state=open]:bg-muted",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground",
        "destructive-ghost": "text-danger hover:bg-danger/10",
        destructive: "bg-destructive text-destructive-foreground shadow-control-destructive hover:bg-destructive/90",
        link: "h-auto px-0 text-brand-text underline-offset-4 hover:underline active:translate-y-0",
      },
      size: {
        sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-8 px-3 text-sm [&_svg]:size-4",
        lg: "h-9 px-4 text-sm [&_svg]:size-4",
        "icon-sm": "size-7 [&_svg]:size-3.5",
        icon: "size-8 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Keeps the label, adds a spinner, and blocks repeat submits. */
  loading?: boolean;
}

export function Button({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "secondary"}
      className={cn(buttonVariants({ variant, size }), className)}
      // Loading is not disabled: it keeps full contrast and its label width,
      // and only stops repeat clicks.
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { buttonVariants };
