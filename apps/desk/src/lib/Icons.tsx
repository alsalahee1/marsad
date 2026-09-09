import type { SVGProps } from 'react';

/** Stroke icons on the 24px grid. Colour is `currentColor`; size comes from the parent. */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const DeskIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="5" rx="1.5" />
    <rect x="13" y="10" width="8" height="11" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
  </Icon>
);

export const AgentsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="17" cy="9.5" r="2.5" />
    <path d="M15.5 19a4.5 4.5 0 0 1 5-4" />
  </Icon>
);

export const ApprovalsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const LogIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h10M4 18h13" />
    <circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2.25" />
    <circle cx="9" cy="17" r="2.25" />
  </Icon>
);

export const HaltIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const ResumeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5v14l11-7z" />
  </Icon>
);

export const ExpandIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const CollapseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);

export const FollowIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);
