// The single icon entry point. Feature code imports icons from here, never
// from the icon package directly, so the set stays curated and swappable.
//
// Rules: 16px in dense UI (size-4), 14px inside sm controls, "regular" weight,
// currentColor only. An icon-only button needs aria-label. Icons label
// things; they never decorate headings or empty space.

import { SquaresFourIcon } from "@phosphor-icons/react/ssr";

export {
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  BellIcon,
  BookOpenIcon,
  BroadcastIcon,
  BuildingsIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  CreditCardIcon,
  DotsThreeIcon,
  FunnelIcon,
  GaugeIcon,
  GearSixIcon,
  KeyIcon,
  KeyboardIcon,
  ListIcon,
  ListMagnifyingGlassIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PathIcon,
  PlugsConnectedIcon,
  PlusIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SquaresFourIcon,
  StackIcon,
  SunIcon,
  TrashIcon,
  TreeStructureIcon,
  UserIcon,
  UsersThreeIcon,
  WarningIcon,
  WarningOctagonIcon,
  XIcon,
} from "@phosphor-icons/react/ssr";

/** Shared component type for icon props in nav configs and patterns. */
export type IconComponent = typeof SquaresFourIcon;
