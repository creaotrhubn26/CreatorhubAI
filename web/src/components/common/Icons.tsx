// Hand-rolled line icons — no icon library dependency. Each is a tiny inline
// SVG, 16-20px, stroke=currentColor so it inherits button/text color and
// theme changes for free.
import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props };
}

export function IconDashboard(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="1.5" y="1.5" width="6" height="6" rx="1" />
      <rect x="8.5" y="1.5" width="6" height="3.5" rx="1" />
      <rect x="8.5" y="6.5" width="6" height="8" rx="1" />
      <rect x="1.5" y="9" width="6" height="5.5" rx="1" />
    </svg>
  );
}

export function IconSessions(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h5l2 2h2A1.5 1.5 0 0 1 14 5.5v7A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-9Z" />
      <path d="M4.5 8h5M4.5 10.5h3.5" />
    </svg>
  );
}

export function IconNewTask(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M8 2v12M2 8h12" />
    </svg>
  );
}

export function IconVerification(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M8 1.5 13.5 4v4.2c0 3.4-2.3 5.6-5.5 6.3-3.2-.7-5.5-2.9-5.5-6.3V4L8 1.5Z" />
      <path d="M5.5 8.2 7.3 10l3.2-3.6" />
    </svg>
  );
}

export function IconRepository(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M3 2h7.5L13 4.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M10 2v3h3" />
      <path d="M4.5 8.5h5M4.5 11h5" />
    </svg>
  );
}

export function IconModel(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.4 3.6l-1.4 1.4M5 9.4l-1.4 1.4M12.4 12.4l-1.4-1.4M5 6.6 3.6 5.2" />
    </svg>
  );
}

export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 2v1.4M8 12.6V14M14 8h-1.4M3.4 8H2M12.1 3.9l-1 1M4.9 11.1l-1 1M12.1 12.1l-1-1M4.9 4.9l-1-1" />
    </svg>
  );
}

export function IconBack(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} width={14} height={14} viewBox="0 0 16 16">
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

export function IconForward(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} width={14} height={14} viewBox="0 0 16 16">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} width={13} height={13} viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3-3" />
    </svg>
  );
}

export function IconChevron({ open, ...props }: SVGProps<SVGSVGElement> & { open: boolean }) {
  return (
    <svg {...base(props)} width={11} height={11} viewBox="0 0 16 16" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>
      <path d="M5 3l6 5-6 5" />
    </svg>
  );
}

export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} width={12} height={12} viewBox="0 0 16 16">
      <path d="M3 3l10 10M13 3 3 13" />
    </svg>
  );
}

export function IconSend(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} width={14} height={14} viewBox="0 0 16 16" fill="currentColor" stroke="none">
      <path d="M2 2.5 14 8 2 13.5 3.6 8.6 9 8 3.6 7.4 2 2.5Z" />
    </svg>
  );
}
