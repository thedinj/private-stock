/**
 * The transport, drawn rather than typed.
 *
 * These were glyphs — a play triangle and two pause bars — and, for mute and fullscreen, literal
 * colour emoji. An emoji renders in the system's emoji font, at whatever weight and baseline that
 * font chooses and in its own fixed colours: in a warm dark player it is the one object on screen
 * that belongs to a different application, and it looks different on every platform. Inline SVG
 * scales, takes `currentColor` from the control around it, and renders identically everywhere.
 *
 * Here rather than inside `VideoPlayer` because the still stage needs the same three — a picture
 * in a show has a play, a pause and a full screen exactly as a film does, and two sets drifting
 * apart is how one of them ends up an emoji again. The player keeps the four only it has: replay,
 * sound, muted and capture.
 *
 * Sound and muted moved here, with close, previous, next, open and timer, when the tasting
 * (§14g) needed its own transport -- and the showcase's two private icons went with them.
 */
export interface GlyphProps {
    /** Edge length in pixels. 20 in a 36px control; 14-16 in the small action icons. */
    size?: number;
}

export const Glyph: React.FC<GlyphProps & { children: React.ReactNode }> = ({
    children,
    size = 20,
}) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
    >
        {children}
    </svg>
);

export const PlayGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none" />
    </Glyph>
);

export const PauseGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M9.5 5v14M14.5 5v14" />
    </Glyph>
);

export const FullscreenGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" />
    </Glyph>
);

export const SoundGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
        <path d="M16.2 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18.8 6.8a7.6 7.6 0 0 1 0 10.4" />
    </Glyph>
);

export const MutedGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
        <path d="M16.5 9.8l4.5 4.4M21 9.8l-4.5 4.4" />
    </Glyph>
);

export const CloseGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M6 6l12 12M18 6L6 18" />
    </Glyph>
);

export const PreviousGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M6 5v14" />
        <path d="M18 5.2v13.6L8.5 12z" fill="currentColor" stroke="none" />
    </Glyph>
);

export const NextGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M18 5v14" />
        <path d="M6 5.2v13.6L15.5 12z" fill="currentColor" stroke="none" />
    </Glyph>
);

/** Out of the show and into the item: a box with an arrow leaving it. */
export const OpenGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M13 4h7v7M20 4l-9 9" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Glyph>
);

/** How long each thing is shown. */
export const TimerGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="12" cy="13" r="7.5" />
        <path d="M12 9v4l2.5 2.5M9.5 2.5h5" />
    </Glyph>
);

/** Cutting a span out of a film: marking a clip (§14d). */
export const ScissorsGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="6" cy="7" r="2.6" />
        <circle cx="6" cy="17" r="2.6" />
        <path d="M8.2 8.4 20 17M8.2 15.6 20 7" />
    </Glyph>
);

/** Settings for how the page plays: two sliders. */
export const SlidersGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
    </Glyph>
);

/** The showcase (§14f): a wall of pictures in rows of differing widths. */
export const ShowcaseGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <rect x="3" y="4" width="8" height="7" rx="1" />
        <rect x="13" y="4" width="8" height="7" rx="1" />
        <rect x="3" y="13" width="5" height="7" rx="1" />
        <rect x="10" y="13" width="11" height="7" rx="1" />
    </Glyph>
);

/** The tasting (§14g): a glass, for a few sips of each. */
export const TastingGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M7 3h10l-.6 5.2a4.4 4.4 0 0 1-8.8 0z" />
        <path d="M12 12.6V20M8.5 20h7" />
    </Glyph>
);

/** The grid layout: small tiles, many to a row. */
export const GridGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <rect x="3.5" y="3.5" width="4.5" height="4.5" rx="0.8" />
        <rect x="9.75" y="3.5" width="4.5" height="4.5" rx="0.8" />
        <rect x="16" y="3.5" width="4.5" height="4.5" rx="0.8" />
        <rect x="3.5" y="9.75" width="4.5" height="4.5" rx="0.8" />
        <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="0.8" />
        <rect x="16" y="9.75" width="4.5" height="4.5" rx="0.8" />
        <rect x="3.5" y="16" width="4.5" height="4.5" rx="0.8" />
        <rect x="9.75" y="16" width="4.5" height="4.5" rx="0.8" />
        <rect x="16" y="16" width="4.5" height="4.5" rx="0.8" />
    </Glyph>
);

/** The gallery layout: large pictures, few to a row. */
export const GalleryGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <rect x="3" y="4" width="18" height="9" rx="1.2" />
        <rect x="3" y="15" width="8" height="5" rx="1" />
        <rect x="13" y="15" width="8" height="5" rx="1" />
    </Glyph>
);

/** More actions, behind a menu: three dots, drawn rather than typed. */
export const MoreGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </Glyph>
);

export const ArrowUpGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M12 19V5M6 11l6-6 6 6" />
    </Glyph>
);

export const ArrowDownGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M12 5v14M6 13l6 6 6-6" />
    </Glyph>
);

export const CheckGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Glyph>
);

/** More about this: a lowercase i in a ring, for a setting's explanation kept behind a hover. */
export const InfoGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5.5" />
        <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
);

export const CopyGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.5" />
        <path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" />
    </Glyph>
);

/** A saved view: a question asked of the library -- a funnel. */
export const ViewGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
    </Glyph>
);

/** "More like this" (§5e): a frame, and another behind it that resembles it. */
export const LookAlikeGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <rect x="3.5" y="8" width="12" height="9.5" rx="1.5" />
        <path d="M8.5 5h10.5A1.5 1.5 0 0 1 20.5 6.5v8.5" />
        <path d="M6.5 15l2.8-3 2.2 2.2 1.5-1.4 2.5 2.2" />
    </Glyph>
);

/** A playlist: a list of chosen things. */
export const ListGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M9 7h11M9 12h11M9 17h11" />
        <circle cx="4.8" cy="7" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.8" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.8" cy="17" r="1" fill="currentColor" stroke="none" />
    </Glyph>
);

/** Moving an item to the trash: a bin with its lid. */
export const TrashGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7M10.3 10.5v5.5M13.7 10.5v5.5" />
    </Glyph>
);

export const PencilGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5z" />
        <path d="M13.8 7.2l3 3" />
    </Glyph>
);

export const UndoGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <path d="M9 7L4.5 11.5 9 16" />
        <path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-2" />
    </Glyph>
);

/**
 * Nobody (§14e): a face drawn only in dashes, for the performer facet's None chip.
 *
 * This was 🫥, the dotted-line face, which is exactly the idea -- but the emoji font decides how
 * it looks, and Windows fills it peach, so the outline that carried the meaning was gone.
 */
export const NobodyGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="12" cy="12" r="8.5" strokeDasharray="2.6 2.4" />
        <circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none" />
        <circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none" />
        <path d="M9.5 15h5" />
    </Glyph>
);

/**
 * Somebody: the same face drawn whole, for the None chip's third state -- "has some performer".
 * Its own picture rather than nobody struck through, which read as a double negative.
 */
export const SomebodyGlyph: React.FC<GlyphProps> = ({ size }) => (
    <Glyph size={size}>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none" />
        <circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none" />
        <path d="M9.3 14.4a3.6 3.6 0 0 0 5.4 0" />
    </Glyph>
);
