import type { SVGProps } from "react";

/** Small inline icon set (no icon library needed). Decorative: hidden from screen readers. */
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className = "size-4", ...rest }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} {...rest}>
      {children}
    </svg>
  );
}

export const FileIcon = (p: IconProps) => (
  <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Icon>
);
export const UploadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></Icon>
);
export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 19h14" /></Icon>
);
export const SparkleIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></Icon>
);
export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>
);
export const LogOutIcon = (p: IconProps) => (
  <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></Icon>
);
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>;
export const CheckCircleIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16.5 9.5" /></Icon>
);
export const AlertIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></Icon>
);
export const InfoIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h.01" /></Icon>
);
export const BuildingIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" /><path d="M16 9h2a2 2 0 0 1 2 2v10" /><path d="M8 7h4M8 11h4M8 15h4M3 21h18" /></Icon>
);
export const PlusIcon = (p: IconProps) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const UsersIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3 5.5" /></Icon>
);
export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-4" /></Icon>
);
export const LockIcon = (p: IconProps) => (
  <Icon {...p}><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></Icon>
);
export const ChevronRightIcon = (p: IconProps) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>;
export const ArrowLeftIcon = (p: IconProps) => <Icon {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>;
export const SwitchIcon = (p: IconProps) => (
  <Icon {...p}><path d="M7 4 4 7l3 3" /><path d="M4 7h13a3 3 0 0 1 3 3" /><path d="m17 20 3-3-3-3" /><path d="M20 17H7a3 3 0 0 1-3-3" /></Icon>
);
export const TrashIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></Icon>
);
export const ActivityIcon = (p: IconProps) => <Icon {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const EyeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const EyeOffIcon = (p: IconProps) => (
  <Icon {...p}><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a16 16 0 0 1-2.3 3.2M6.6 6.6C3.9 8.3 2.5 12 2.5 12s3.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m3 3 18 18" /></Icon>
);
export const CopyIcon = (p: IconProps) => (
  <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>
);
export const SmartphoneIcon = (p: IconProps) => (
  <Icon {...p}><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 18h2" /></Icon>
);

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`animate-spin ${className}`}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
/** A commit on a branch, for the GitHub section. Not GitHub's logo, which is a trademark. */
export const GitBranchIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8" /><path d="M18 10a6 6 0 0 1-6 6H8" /></Icon>
);
/** A panel with a sidebar, for collapsing and expanding a side menu. */
export const PanelLeftIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>
);
/** Four tiles, for the list of workspaces. */
export const GridIcon = (p: IconProps) => (
  <Icon {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Icon>
);
/** A box with an arrow leaving it, for a link that opens in a new tab. */
export const ExternalLinkIcon = (p: IconProps) => (
  <Icon {...p}><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Icon>
);
