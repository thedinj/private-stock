import { Glyph, type GlyphProps } from "@/components/media/Glyph";

/**
 * What stands in a tag's picture slot until it has a picture (§6 "A tag's picture").
 *
 * The slot is held at the picture's size either way, so a card or a suggestion is the same size
 * before its picture is drawn as after -- a list whose rows jump when one gains a picture is a
 * list somebody mis-taps. The glyph says which facet it is: a person, a source, a keyword.
 */
export const TagKindGlyph: React.FC<GlyphProps & { kind: string }> = ({ kind, size = 28 }) => {
    if (kind === "performer") {
        return (
            <Glyph size={size}>
                <circle cx="12" cy="8.5" r="3.5" />
                <path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6" />
            </Glyph>
        );
    }

    if (kind === "source") {
        // A film frame: where the footage came from.
        return (
            <Glyph size={size}>
                <rect x="4" y="5" width="16" height="14" rx="1.5" />
                <path d="M8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4" />
            </Glyph>
        );
    }

    return (
        <Glyph size={size}>
            <path d="M4 4.5v6.3l8.7 8.7a1.5 1.5 0 0 0 2.1 0l4.7-4.7a1.5 1.5 0 0 0 0-2.1L10.8 4H4.5z" />
            <circle cx="8" cy="8" r="1.4" />
        </Glyph>
    );
};
