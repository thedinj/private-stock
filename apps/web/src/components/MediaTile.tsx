"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AspectRatio, Badge, Box, Card, Checkbox, Group, Text } from "@mantine/core";

import type { LookMoment, MediaListItem } from "@private-stock/core";

import { ReleasingVideo } from "@/components/media/ReleasingVideo";
import { MiddleEllipsis } from "@/components/MiddleEllipsis";
import { itemHref } from "@/lib/lookMoment";
import { rememberReturn } from "@/lib/returnTo";
import { centreSquare, spriteCropStyle } from "@/lib/spriteCrop";
import { useHoverIntent, useTilePreview } from "@/lib/useTilePreview";

import classes from "./MediaTile.module.scss";

/**
 * One item in the library grid.
 *
 * The wine-cellar treatment lives here: a hairline brass edge, an inset shadow so the tile
 * reads as a bottle in a rack, and a candle-warm glow on hover rather than a blue focus
 * ring. Texture stays in the frame; nothing is painted over the media itself.
 */

const formatDuration = (ms: number | null): string | null => {
    if (!ms || ms <= 0) return null;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/**
 * When the item arrived, short enough to sit beside the height and the stars.
 *
 * The default sort is by date added, so this is the field somebody is actually scanning for
 * -- and a tile that sorts by something it does not show makes the order look arbitrary. The
 * year appears only when it is not this one, which keeps the common case to five characters.
 */
const formatAdded = (iso: string): string | null => {
    const date = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");

    if (Number.isNaN(date.getTime())) return null;

    const sameYear = date.getFullYear() === new Date().getFullYear();

    return date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(sameYear ? {} : { year: "numeric" }),
    });
};

interface MediaTileProps {
    item: MediaListItem;
    /**
     * Gallery mode: this tile autoplays its preview when it is on screen, without a hover.
     * The budget still decides whether it actually may (§14).
     */
    gallery?: boolean;
    /** Whether this tile is ticked. `undefined` means the grid is not in selection mode. */
    selected?: boolean;
    onToggleSelected?: (mediaId: string, shiftKey: boolean) => void;
    /**
     * Records where the item was opened from. The page's own address by default, which is
     * the whole set for a library or playlist; the room passes its shelf (§14b).
     */
    onOpen?: () => void;
    /** Among the first screenful: fetch the cover eagerly and ahead of the rest of the page. */
    priority?: boolean;
    /**
     * Where this item matched a look (§5e). The tile then shows that frame rather than the
     * cover, says when it is, and opens there: the match is the evidence, and the cover of a
     * twenty-minute video rarely shows the glasses.
     */
    moment?: LookMoment;
}

export const MediaTile: React.FC<MediaTileProps> = ({
    item,
    gallery = false,
    selected,
    onToggleSelected,
    onOpen = rememberReturn,
    priority = false,
    moment,
}) => {
    // Videos only. A photograph is probed as a single frame of a few milliseconds, which is
    // not zero, so it was stamped "0:00" -- a length it does not have.
    const duration = item.kind === "video" ? formatDuration(item.durationMs) : null;
    const atMs = item.kind === "video" && moment ? moment.atMs : null;
    // Where it matched, of how long it is: "4:10 / 22:31".
    const timeBadge =
        atMs === null
            ? duration
            : [formatDuration(atMs) ?? "0:00", duration].filter(Boolean).join(" / ");

    const [onScreen, setOnScreen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const { hovered, onEnter, onLeave } = useHoverIntent();
    const { mayPlay, playing, videoRef, onPlaying } = useTilePreview(
        item.previewUrl,
        hovered,
        gallery && onScreen
    );

    /**
     * Only observe intersection in gallery mode.
     *
     * In ordinary grid mode nothing autoplays, so an observer per tile would be pure cost —
     * and the grid is virtualized, so tiles mount and unmount constantly while scrolling.
     */
    useEffect(() => {
        if (!gallery || !containerRef.current || typeof IntersectionObserver === "undefined") {
            return;
        }

        const element = containerRef.current;
        const observer = new IntersectionObserver(
            ([entry]) => setOnScreen(entry.isIntersecting),
            // Half visible, so a tile peeking over the fold does not claim a decoder slot
            // ahead of one the viewer is actually looking at.
            { threshold: 0.5 }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [gallery]);

    const added = formatAdded(item.addedAt);

    // The short side, as the resolution filter and sort read it. The height alone called a
    // portrait 1080×1920 "1920p" while sorting it among the 1080p items, which looked like the
    // sort was wrong.
    const resolution = item.width && item.height ? `${Math.min(item.width, item.height)}p` : null;

    /*
     * Two names and then a count. A fixed number rather than "as many as fit": a tile whose
     * height depends on its content makes a five-column grid ragged, and the grid's regularity
     * is most of what makes it readable at a glance (§14b). The slicing happens on the server,
     * so a heavily tagged item does not ship forty names to draw two.
     *
     * Under the title in Gallery, over the picture on hover in the grid. Every tile in a rack
     * carrying its title, its resolution, its date and two tag chips was four lines of small
     * print sixty times over; the grid is for finding a thing by its picture, and the detail
     * is there the moment the pointer settles on one.
     */
    const tagChips =
        item.tags.length > 0 ? (
            <>
                {item.tags.map((tag) => (
                    <Text key={`${tag.kind}:${tag.name}`} size="xs" className={classes.tag}>
                        {tag.name}
                    </Text>
                ))}
                {item.tagCount > item.tags.length && (
                    <Text size="xs" c="dimmed" className={classes.more}>
                        +{item.tagCount - item.tags.length}
                    </Text>
                )}
            </>
        ) : null;

    /*
     * Who is in it, under the title, always (§14b).
     *
     * The chips went to the hover so a rack stopped being four lines of small print per tile;
     * the people came back as one line because they are what a rack is scanned for, and on a
     * phone there is no hover to find them behind. A byline rather than chips: names in the
     * tag page's warm small print, read as a credit, not as controls. One line, two names and a
     * count, clipped -- the tile's height never depends on how many people are in it. Plain
     * text, not links: the tile is one already, and a link inside a link is not one.
     */
    const byline =
        item.performers.length > 0
            ? item.performers.join(", ") +
              (item.performerCount > item.performers.length
                  ? ` +${item.performerCount - item.performers.length}`
                  : "")
            : null;

    return (
        <Card
            component={Link}
            // No prefetch at all. A grid page is sixty tiles, so the default had the browser
            // request sixty `/media/:id` RSC payloads for a page nobody had opened -- alongside
            // the sixty covers, over the same connections. In the App Router `false` turns off
            // hover prefetch as well as viewport prefetch; the item page loads on click.
            prefetch={false}
            href={itemHref(item.id, atMs)}
            className={classes.tile}
            padding={0}
            radius="sm"
            // The morph's handles (§14, "Motion"): which item this tile is, and below, which
            // box is its frame -- the part that grows into the viewer's stage and back.
            data-media-id={item.id}
            // Records the library view being left, so the item has somewhere to send you
            // back to that is not the front door.
            onClick={onOpen}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            // A touch device has no hover; tapping navigates, and gallery mode is how someone
            // on a phone sees previews at all.
            onFocus={onEnter}
            onBlur={onLeave}
        >
            <AspectRatio ratio={16 / 9}>
                <Box className={classes.thumb} ref={containerRef} data-morph-frame>
                    {item.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={item.coverUrl}
                            alt=""
                            loading={priority ? "eager" : "lazy"}
                            fetchPriority={priority ? "high" : "auto"}
                            decoding="async"
                            className={classes.image}
                        />
                    ) : (
                        // No cover yet. A placeholder that reads as "pending" rather than
                        // "broken" matters while a first scan works through a large library.
                        <Box className={classes.placeholder}>
                            <Text size="xs" c="dimmed" ta="center" px="xs">
                                {item.probed ? item.kind : "processing…"}
                            </Text>
                        </Box>
                    )}

                    {/* A square from the centre of the frame, whatever its shape, in the middle of
                        the tile: the whole frame cropped into 16:9 stretched an upright one. */}
                    {moment?.thumbUrl && moment.thumbRect && (
                        <Box className={classes.moment}>
                            <Box
                                className={classes.momentSquare}
                                style={spriteCropStyle(
                                    moment.thumbUrl,
                                    centreSquare(moment.thumbRect)
                                )}
                                role="img"
                                aria-label="The moment that matched"
                            />
                        </Box>
                    )}

                    {mayPlay && item.previewUrl && (
                        <ReleasingVideo
                            ref={videoRef}
                            src={item.previewUrl}
                            className={classes.preview}
                            // Muted is not a preference here: it is the condition browsers
                            // require before they will autoplay anything at all.
                            muted
                            loop
                            playsInline
                            preload="none"
                            aria-hidden
                            onPlaying={onPlaying}
                            // Cross-fade from the cover only once frames are actually
                            // arriving, so a slow preview never shows a black rectangle.
                            style={{ opacity: playing ? 1 : 0 }}
                        />
                    )}

                    {timeBadge && (
                        <Badge
                            className={classes.duration}
                            size="sm"
                            variant="filled"
                            color={atMs === null ? "dark" : "brass"}
                            title={atMs === null ? undefined : "Where it matched, of its length"}
                        >
                            {timeBadge}
                        </Badge>
                    )}
                    {/* The rating, on the picture opposite the duration, in the same kind of
                        badge. It was half of the line under the title, and that line was empty
                        beside it on every tile with no performers; here it costs no height, and
                        the byline gets the whole width. */}
                    {item.rating && (
                        <Badge className={classes.rating} size="sm" variant="filled" color="dark">
                            {/* Coloured inside the label: Mantine sets the badge's own colour
                                inline, where a stylesheet cannot reach it. */}
                            <span className={classes.stars}>{"★".repeat(item.rating)}</span>
                        </Badge>
                    )}

                    {/* A heart, not a star, and oxblood rather than brass.
                        
                        The tile carries two marks and they must not be read for each other:
                        the rating under the title is brass stars, so a favourite drawn as a
                        brass star said "rated" to anyone glancing at the grid — including, at
                        least once, someone debugging why a rated item was showing up under
                        "Unrated only". It was not rated; it was favourited.

                        The item page has always used ♥/♡ for this. The grid now agrees. */}
                    {item.favorite && (
                        <Badge
                            className={classes.favorite}
                            size="sm"
                            variant="filled"
                            color="oxblood"
                            aria-label="Favourite"
                        >
                            ♥
                        </Badge>
                    )}

                    {/* The tile is a link, so the checkbox has to stop the click reaching
                        it — ticking an item and opening it are different intentions and the
                        one you get must not depend on hitting a 16px target. Shown on hover
                        and focus, and always once anything is selected: a grid mid-selection
                        has to show which tiles are in it without being pointed at. */}
                    {onToggleSelected && (
                        <Box
                            className={classes.check}
                            data-active={selected ? "true" : undefined}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onToggleSelected(item.id, event.shiftKey);
                            }}
                        >
                            <Checkbox
                                checked={Boolean(selected)}
                                color="brass"
                                size="sm"
                                tabIndex={-1}
                                readOnly
                                aria-label={selected ? "Deselect" : "Select"}
                            />
                        </Box>
                    )}

                    {/* No "watched" mark here. A brass tick in a corner of the frame is a
                        brass tick in a corner of the frame -- which is also what the
                        selection checkbox is, eight pixels away on the other side, and at a
                        glance across a rack the two were the same object. Whether you have
                        seen something is a question you ask of one item or of the whole
                        library at once, and the second is answered better elsewhere: the
                        filter panel's Watched control, which can also ask the question the
                        other way round (§14e). */}

                    {/* The details a rack does not need at a glance, over the picture on hover
                        (grid only). Over it rather than under the title, so pointing at a tile
                        changes nothing about its height or its neighbours'. */}
                    {!gallery && (resolution || added || item.tags.length > 0) && (
                        <Box className={classes.hoverInfo}>
                            {resolution && (
                                <Text size="xs" className={classes.hoverResolution}>
                                    {resolution}
                                </Text>
                            )}
                            {/* Here since the byline took its place under the title: when an
                                item arrived is a detail, not what a rack is scanned for. */}
                            {added && (
                                <Text size="xs" className={classes.hoverResolution}>
                                    {added}
                                </Text>
                            )}
                            {tagChips}
                        </Box>
                    )}
                </Box>
            </AspectRatio>

            <Box className={classes.caption}>
                {/* Cut in the middle: a rack of scene names shares its beginnings and differs at
                    the end, which is the part an end cut throws away. */}
                <MiddleEllipsis text={item.title} size="sm" fw={500} className={classes.title} />
                <Group gap={6} mt={2} wrap="nowrap" className={classes.meta}>
                    {byline && (
                        <Text size="xs" c="oak.3" className={classes.byline}>
                            {byline}
                        </Text>
                    )}
                    {gallery && resolution && (
                        <Text size="xs" c="dimmed" ml="auto" className={classes.fixed}>
                            {resolution}
                        </Text>
                    )}
                </Group>

                {gallery && tagChips && (
                    <Group gap={4} mt={4} wrap="nowrap" className={classes.tags}>
                        {tagChips}
                    </Group>
                )}
            </Box>
        </Card>
    );
};
