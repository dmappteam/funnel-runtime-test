import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
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

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

/** `pathLength` lets CSS draw the tick regardless of the icon size. */
export const CheckIcon = (props: IconProps) => (
  <Icon strokeWidth={3} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" pathLength={1} />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon strokeWidth={2.4} {...props}>
    <path d="M5 12h14" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon strokeWidth={2.4} {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
);

export const CloudOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m2 2 20 20" />
    <path d="M5.8 8.2A5.5 5.5 0 0 0 7 19h10.5" />
    <path d="M21.5 15.6A4.5 4.5 0 0 0 17.5 9h-1.3A7 7 0 0 0 9.6 4.2" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5h.01" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5h.01" />
  </Icon>
);
