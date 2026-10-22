// The handful of icons the console needs, drawn once at 16px on a 16-unit
// grid with a 1.5 stroke. Decorative by default (aria-hidden); pair with text.

type IconProps = React.SVGProps<SVGSVGElement>;

function Svg({ children, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export function TrafficIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 13.5h12" />
      <path d="M3.5 11V8M6.5 11V4M9.5 11V6.5M12.5 11V2.5" />
    </Svg>
  );
}

export function RequestsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </Svg>
  );
}

export function ErrorsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2 14.5 13.5h-13L8 2Z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </Svg>
  );
}

export function SetupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0V5ZM8 11.5V14" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3 8.5 3 3 7-7" />
    </Svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </Svg>
  );
}
