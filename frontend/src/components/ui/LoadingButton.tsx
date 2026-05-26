"use client";

import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { Loader2 } from "lucide-react";

interface LoadingButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  /** Text to show alongside the spinner while loading (e.g., "Saving…"). Optional. */
  loadingText?: ReactNode;
  /** Icon to render before the label when NOT loading. */
  leadingIcon?: ReactNode;
  /** Icon to render after the label when NOT loading. */
  trailingIcon?: ReactNode;
  children: ReactNode;
}

/**
 * Button wrapper that toggles between content and a spinner without
 * collapsing the button's width — uses visibility: hidden on the content
 * so the layout is locked in place during async operations.
 *
 * Pairs with any existing button class (.settings-btn, .auth-submit-btn, etc.) —
 * pass it via className.
 */
const LoadingButton = forwardRef<HTMLButtonElement, LoadingButtonProps>(
  (
    { isLoading = false, loadingText, leadingIcon, trailingIcon, children, disabled, className, ...rest },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || isLoading}
        aria-busy={isLoading || undefined}
        className={className}
        style={{ position: "relative", ...(rest.style ?? {}) }}
        {...rest}
      >
        {/* Spinner overlay — absolutely positioned so it sits centered over the
            hidden label and the button doesn't reflow. */}
        {isLoading && (
          <span
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
            }}
          >
            <Loader2 size={16} className="animate-spin" />
            {loadingText && <span>{loadingText}</span>}
          </span>
        )}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            visibility: isLoading ? "hidden" : "visible",
          }}
        >
          {leadingIcon}
          {children}
          {trailingIcon}
        </span>
      </button>
    );
  },
);

LoadingButton.displayName = "LoadingButton";

export default LoadingButton;
