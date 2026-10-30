"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
    ActionIcon,
    Anchor,
    AspectRatio,
    Box,
    Button,
    Center,
    Group,
    Kbd,
    Loader,
    Menu,
    Popover,
    SegmentedControl,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";

import { LoadFailed } from "@/components/LoadFailed";
import { MediaDetailsDrawer } from "@/components/media/MediaDetailsDrawer";
import { ItemPerformers } from "@/components/faces/ItemPerformers";
import { WhoIsThis } from "@/components/faces/WhoIsThis";
import { MediaNote } from "@/components/media/MediaNote";
import { FrameStrip } from "@/components/media/FrameStrip";
import { LookAlikeGlyph, SlidersGlyph, TrashGlyph } from "@/components/media/Glyph";
import { SectionLabel } from "@/components/media/SectionLabel";
import {
    isGrand,
    pickAccolade,
    StageFlash,
    type StageFlashMessage,
} from "@/components/media/StageFlash";
import { ClipBar } from "@/components/media/ClipBar";
import { ClipStrip } from "@/components/media/ClipStrip";
import { AddToPlaylist } from "@/components/playlist/AddToPlaylist";
import { useCreateClip } from "@/lib/api/reels";
import { useCaptureFrame } from "@/lib/api/frames";
import { stageWorkInterval } from "@/lib/api/processing";
import { RatingControl } from "@/components/RatingControl";
import { TagEditor } from "@/components/TagEditor";
import { TranscodeNotice } from "@/components/TranscodeNotice";
import { TrashConfirm } from "@/components/TrashConfirm";
import { StillStage } from "@/components/media/StillStage";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useAuth } from "@/lib/api/AuthProvider";
import { api } from "@/lib/api/client";
import { BACKGROUND } from "@/lib/api/background";
import { mediaDetailQuery } from "@/lib/api/media";
import { DEFAULT_VIEW, viewToParams } from "@/lib/libraryQuery";
import { itemHref } from "@/lib/lookMoment";
import { readReturn, rememberReturnTo, returnAtPage, returnLabel } from "@/lib/returnTo";
import { leaveViewer } from "@/lib/viewerReturn";
import { openingPicture } from "@/lib/openItem";
import { morphOutOfStage } from "@/lib/viewTransitions";
import { useViewerSequence } from "@/lib/useViewerSequence";
import { parseAtParam, resumeTarget, visitPosition } from "@/lib/resumePoint";
import { isTypingTarget } from "@/lib/typingTarget";
import { useSpillLight } from "@/lib/useSpillLight";
import { useWarmIntent } from "@/lib/warmMonitor";
import { useStudyRoom } from "@/lib/useStudyRoom";
import { usePlaybackPref, useDwellSeconds } from "@/lib/playbackPrefs";
import { DWELL_CHOICES, dwellMs, snapDwellSeconds, stageMode, stillSource } from "@/lib/stageDwell";
import {
    ratingAfterPressing,
    ratingWhilePending,
    useUserMedia,
    type UserMediaPatch,
} from "@/lib/api/userMedia";

import classes from "@/components/media/PlayerStage.module.scss";

/**
 * Playback (§14).
 *
 * The film, its name, how you feel about it, and one way in. That is the whole page.
 *
 * It used to say considerably more, all of it above the fold: four metadata badges of equal
 * weight, the relative path, a divider and the tag editor, before you had decided whether you
 * wanted any of it. None of that was wrong, and none of it was cut — it moved into the
 * details drawer, where it can be thorough without talking over the thing you came to watch.
 */

const InfoIcon = () => (
    <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden
        focusable="false"
    >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 7.6v.1" />
    </svg>
);

const MediaPage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);
    const router = useRouter();
    const [detailsOpen, details] = useDisclosure(false);

    /**
     * Where "back" goes.
     *
     * Read once, on mount, rather than on every render: it is a fact about how this page was
     * arrived at, and it must not change under the viewer while they are looking at it.
     * `useState` with an initialiser reads it after hydration, so the server and the client
     * render the same thing.
     */
    const [returnTo] = useState<string | null>(() =>
        typeof window === "undefined" ? null : readReturn()
    );

    const sequence = useViewerSequence(returnTo, id);

    /**
     * A moment the address names, `?at=<ms>` — how the Captures page opens a video where a
     * still was taken (§14b).
     *
     * Read reactively rather than once: stepping to the next item replaces the address in place,
     * without `at`, and that item must open at its own resume point, not at this one's moment.
     */
    const searchParams = useSearchParams();
    const startAtMs = parseAtParam(searchParams.get("at"));

    /**
     * The room, and its light (§14).
     *
     * The library is the cellar; this is the study next door. The shell dims around the
     * player for as long as an item is open, and the glow the frame throws is sampled from
     * the picture rather than fixed — so the walls take the colour of whatever is on screen.
     *
     * Both are enhancements over a page that already looked right: the room is one attribute
     * driving tokens, and the light falls back to the amber that is written in the CSS.
     */
    useStudyRoom();

    const stageRef = useRef<HTMLDivElement>(null);

    useSpillLight(stageRef);

    /**
     * The playhead, read only when the capture button is pressed (§13).
     *
     * A ref rather than state: the position changes four times a second and nothing on this
     * page displays it, so holding it in state would re-render a page containing a video
     * player for a value nobody is looking at.
     */
    const positionRef = useRef(0);
    /** The element playing, for "Who is this?" to draw the frame it stopped on (§5f). */
    const elementRef = useRef<HTMLVideoElement | null>(null);

    /**
     * Whether the last press produced something, for a moment.
     *
     * The strip that shows the result lives behind the Details button, so without this the
     * button would do its work and look like it had done nothing.
     */
    /**
     * Whether the enlarged view has the keyboard.
     *
     * The player's key handler is bound to the document so that space works the moment the
     * page opens, which means it also hears keys aimed at anything opened over it.
     */
    const [lightboxOpen, setLightboxOpen] = useState(false);
    /** "Who is this?" open (§5f): it takes the keys as the enlarged frame view does. */
    const [whoIsThisOpen, setWhoIsThisOpen] = useState(false);
    /** A view over the page that owns the keys while it is open. */
    const overlayOpen = lightboxOpen || whoIsThisOpen;

    /**
     * Whether the trash confirmation has the keyboard -- for the same reason as the lightbox.
     *
     * One dialog for the three ways in (the icon by the title, `Delete`, the drawer's button),
     * owned here so the key can open it. While it is up, space and Enter belong to its buttons;
     * a space that also paused the film would be two answers to one keystroke.
     */
    const [trashOpen, trashDialog] = useDisclosure(false);
    const { hasScope } = useAuth();

    /**
     * Whether the player gave up on this item after claiming it could play it.
     *
     * The still's own decode failure belongs to `StillStage`, which is also where the reset per
     * arrival now lives — this was a `stillFailed` flag on the page with no reset at all, so one
     * undecodable photograph made every later photograph in the set claim to be broken. The page
     * instance survives a step to the next item (§8b), and anything latched here has to say so.
     */
    const [playerFailed, setPlayerFailed] = useState(false);

    useEffect(() => setPlayerFailed(false), [id]);

    /** Filled by the player, so a frame can send the playhead back to where it was taken. */
    const seekRef = useRef<((ms: number) => void) | null>(null);

    /**
     * Bring the player on screen. A moment is chosen from below it -- the frame strip, the
     * details drawer -- and moving a playhead nobody can see looks like nothing happened.
     * A player wholly in view is left alone; otherwise its top goes under the header. Not
     * `block: "nearest"`, which aligns the bottom edge of a player taller than the window and
     * leaves the top of the picture cut off.
     */
    const showStage = useCallback((behavior: ScrollBehavior) => {
        const stage = stageRef.current;
        if (!stage) return;

        const { top, bottom } = stage.getBoundingClientRect();
        const headerClear = parseFloat(getComputedStyle(stage).scrollMarginTop) || 0;

        if (top >= headerClear && bottom <= window.innerHeight) return;

        stage.scrollIntoView({ block: "start", behavior });
    }, []);

    const seekAndShow = useCallback(
        (atMs: number) => {
            seekRef.current?.(atMs);
            showStage("smooth");
        },
        [showStage]
    );

    /**
     * The span being marked, and the span being previewed (§14d).
     *
     * The selection lives here rather than in the player because a saved clip is a row about the
     * item, not a fact about playback — the same split the capture button already uses. The
     * player reports where the playhead was when a key was pressed and knows nothing else.
     *
     * `]` before `[` is ignored rather than swapping the two silently: the keys are next to each
     * other and a press in the wrong order is far more often a slip than an intention.
     */
    const [selection, setSelection] = useState<{ startMs: number; endMs: number | null } | null>(
        null
    );
    const [preview, setPreview] = useState<{
        startMs: number;
        endMs: number;
        speed: number | null;
        token: number;
    } | null>(null);

    /**
     * Both belong to the item they were made on, and are dropped on the way to the next one.
     *
     * During render rather than in an effect: the player's span effect runs before the page's
     * effects, and a clip preview still standing when n was pressed was handed to the next item's
     * element as an arrival -- seeking it to the old clip's in point and playing it, whatever
     * "Play on open" said. A marked in point carried over would put one file's timecode on
     * another file's clip.
     */
    const [spansOf, setSpansOf] = useState(id);

    if (spansOf !== id) {
        setSpansOf(id);
        setSelection(null);
        setPreview(null);
    }

    const createClip = useCreateClip(() => setSelection(null));

    /**
     * Watch one span, and watch it again if asked again.
     *
     * The token is what makes the second press work: the player keys an arrival on the span it
     * was handed, and asking for the clip that has just finished is the same timecodes twice.
     *
     * No seek here any more. The player seeks on arrival — waiting for metadata if it has to —
     * and doing it from both places raced, because this one fired whether or not the element had
     * loaded anything yet.
     */
    const previewToken = useRef(0);

    const playSpan = (span: { startMs: number; endMs: number; speed: number | null }) => {
        previewToken.current += 1;
        setPreview({ ...span, token: previewToken.current });
    };

    const capture = useCaptureFrame(id);

    const [autoplayOnOpen, setAutoplayOnOpen] = usePlaybackPref("autoplayOnOpen");
    const [autoplayNext, setAutoplayNext] = usePlaybackPref("autoplayNext");
    const [dwellSeconds, setDwellSeconds] = useDwellSeconds();

    /**
     * Moving to another item keeps the set.
     *
     * `replace` rather than `push`: stepping through forty items would otherwise stack forty
     * history entries, and the back button -- which is what the back link uses to return you
     * to the grid, scrolled where you left it -- would have to be pressed forty times to get
     * out. Replacing keeps "back" meaning "back to the library".
     */
    const sequenceRef = useRef(sequence);

    sequenceRef.current = sequence;

    /**
     * The recorded address moves with you.
     *
     * Step past the last item of a page and the next item is on the page after. The address
     * is what the next item page reads its set from, and what "back" returns to, so it is
     * rewritten to that page before going: otherwise the new item is looked for on the old
     * page, is not there, and the viewer loses its place — no next, nothing warmed — while
     * "back" returns to a page you left long ago (§14b).
     */
    const go = useCallback(
        (target: string | null) => {
            if (!target) return;

            const { page, pageOf, momentOf } = sequenceRef.current;
            const targetPage = pageOf(target);
            // Through a look's set, each item opens where it matched, as its tile does (§5e).
            const matchedAt = momentOf(target);

            if (returnTo && page !== null && targetPage !== null && targetPage !== page) {
                rememberReturnTo(returnAtPage(returnTo, targetPage));
            }

            router.replace(itemHref(target, matchedAt));
        },
        [router, returnTo]
    );

    /**
     * Out of an item that has just gone to the bin.
     *
     * On to the next item in the set, as if it had finished, because deleting is most often
     * weeding and the next candidate is what you want to look at. With no next, back to wherever
     * the back link leads — Home was always the destination, which threw away the grid or
     * playlist being weeded. Read from the ref: the sequence is the one from before the delete,
     * which is the one that still knows what came after this item.
     *
     * Past anything that went with it. Copies of an item tend to sit side by side -- same name,
     * same date -- so the next item in the set is often a copy just trashed with this one
     * (§10d), and stepping onto it would open an item that is no longer there.
     */
    const afterDelete = useCallback(
        (trashed: string[]) => {
            const { nextId, upcomingIds, page } = sequenceRef.current;
            const gone = new Set(trashed);
            const onward = [nextId, ...upcomingIds].find(
                (candidate): candidate is string => !!candidate && !gone.has(candidate)
            );

            if (onward) {
                go(onward);
            } else if (returnTo) {
                leaveViewer(returnTo, id, page, router);
            } else {
                // `replace`, so the browser's own back button does not land on the deleted item.
                router.replace("/");
            }
        },
        [go, id, returnTo, router]
    );

    const {
        data,
        isLoading,
        error,
        refetch: refetchItem,
    } = useQuery({
        // The same entry a pressed tile warmed (`lib/openItem.ts`), so arriving from one is
        // normally a cache hit.
        ...mediaDetailQuery(id),
        // Only while a stage is on its way, so a result asked for from the drawer turns up
        // without a reload. Structural sharing keeps every unchanged field the same object,
        // so the player is not disturbed by a poll that changed nothing it reads.
        refetchInterval: stageWorkInterval,
    });

    /**
     * Arriving at a named moment (`?at=`, from the Captures page) shows the player too. Keyed
     * on whether the item has loaded rather than on the item, so a poll does not scroll the
     * page back while somebody is reading below.
     */
    const loaded = data !== undefined;

    useEffect(() => {
        if (loaded && startAtMs !== null) showStage("instant");
    }, [loaded, id, startAtMs, showStage]);

    /**
     * This viewer's opinion, without reaching for the mouse (§6).
     *
     * The cascade is the hook's, shared with the stars: a rating is a membership test as
     * well as a property, so the same set of caches has to move whichever control set it.
     */
    const rate = useUserMedia(id);

    /**
     * The next item, fetched while you are still watching this one (§8b).
     *
     * Three things used to happen in series after pressing next, none of them video: the
     * route's payload, this page blanking to a loader, and then these details. Under the same
     * key the next page will read, so arriving there is a cache hit and the player mounts
     * without a gap.
     *
     * It is also what says whether the *bytes* are worth warming. `directPlay` is not on a list
     * item — only on the details — so this query is both halves of the answer: it removes a
     * round trip, and it is the only thing that knows whether the file the browser is about to
     * download is one the browser can play (§8).
     *
     * Read-ahead, so `BACKGROUND`: nobody is waiting on the next item while looking at this one,
     * and without it the header's rail lit after every open (§14, "Waiting").
     */
    const nextDetail = useQuery({
        ...mediaDetailQuery(sequence.nextId ?? ""),
        enabled: sequence.nextId !== null,
        staleTime: 60_000,
        meta: BACKGROUND,
    });

    /**
     * The route's own payload, which no `<Link>` is here to warm.
     *
     * Stepping through a set is `router.replace`, so nothing prefetches the way a link in the
     * sidebar would. Both directions: going back through a set is as ordinary as going on, and
     * a route payload is a few kilobytes either way.
     */
    useEffect(() => {
        for (const target of [sequence.nextId, sequence.previousId]) {
            if (target) router.prefetch(`/media/${target}`);
        }
    }, [router, sequence.nextId, sequence.previousId]);

    /**
     * What the stage should be fetching in the background, in whichever form it will be shown.
     *
     * This used to be "the next item if it is a direct-playable video, otherwise nothing", on the
     * grounds that warming an image is a cover the grid already has. True of a *tile* and false of
     * the stage: a photograph here is the original file, and it is the one thing on this page that
     * can take four seconds to arrive off a NAS. So both are warmed now — the file for a picture,
     * the cover for a film awaiting conversion — and warming a pending transcode is still refused,
     * because that would download an original nothing can decode (§8b).
     *
     * Each stage has the last word: both refuse on a phone and on a metered connection.
     */
    const nextMode = nextDetail.data ? stageMode(nextDetail.data) : null;

    const warmableVideo = nextMode === "player" ? (sequence.nextId ?? null) : null;

    const warmableStill =
        nextMode === "still" && nextDetail.data ? stillSource(nextDetail.data) : null;

    /**
     * Which stage this item gets, and for how long (§14b).
     *
     * Every video is offered to the player, including one `assessPlayback` expects this browser
     * to refuse (§8): that verdict is one answer for every device, and the one in somebody's hand
     * often does better -- HEVC decodes on most recent phones and GPUs. A refusal is
     * `playerFailed`, and the stage falls back to the cover with the notice saying why, which is
     * also what keeps a rolling show moving: it used to mount a player for such a file, get an
     * error and leave an empty stage, and the fallback is what lets trying be safe.
     */
    const mode = data?.kind === "video" && !playerFailed ? "player" : "still";

    /**
     * Why nothing is being warmed, when nothing is, for the admin's warming overlay (§8b,
     * "Seeing it work"). The stages only know that they were offered nothing; this page knows
     * why. Inert unless the overlay is on.
     */
    const stageName = (stage: "player" | "still") => (stage === "player" ? "a video" : "a still");
    const warmNote =
        sequence.nextId === null
            ? returnTo === null
                ? "opened outside a set, so nothing comes next"
                : "end of the set"
            : nextMode === null
              ? "the next item's details are still loading"
              : nextMode !== mode
                ? `next is ${stageName(nextMode)} and this is ${stageName(mode)}; the viewer does not warm across stages`
                : null;

    useWarmIntent(warmNote === null ? null : { nextId: sequence.nextId, note: warmNote });

    /** A phone: the actions go icon-only and the set's controls stand 44px (CLAUDE.md). */
    const narrow = useMediaQuery("(max-width: 48em)") ?? false;

    /**
     * Whether "Hold each picture" can apply here (§14b).
     *
     * It used to be offered always, including across a set of nothing but films, where it
     * governs nothing. It applies when a still is on the stage, when the next item will be one
     * (its details are already fetched, and `stageMode` knows about films awaiting a rendition),
     * or when a photograph is anywhere in the loaded stretch ahead. A film further on that cannot
     * play is not predictable from a list row -- but it becomes a still the moment it arrives,
     * and the control appears then, and in the still's own bar.
     */
    const dwellApplies =
        mode === "still" ||
        nextMode === "still" ||
        sequence.upcoming.some((item) => item.kind === "image");

    const hold = dwellMs({
        mode,
        autoplayNext,
        hasNext: sequence.nextId !== null,
        seconds: dwellSeconds,
    });

    /**
     * A picture's time is up.
     *
     * **A photograph that was looked at for its whole dwell counts as watched; a cover standing
     * in for a film does not.** The whole of a photograph is on screen for the whole time, which
     * is the same claim §14b's `min(30s, 90% of duration)` makes about a short video — and without
     * it "unwatched only" over a library of pictures is a filter that can never change. A
     * thumbnail of an unconverted film is not the film, so that path records nothing.
     *
     * Only on an *elapsed* dwell: never on arrival, never on pressing Next early, and never while
     * the tab was hidden, because the clock does not run then. "Opened at all" was rejected once
     * and does not come back through a side door. Nothing is invalidated, as with every other
     * progress write — the badge catches up on the next list fetch.
     */
    const onDwellEnded = useCallback(() => {
        if (data?.kind === "image") {
            void api(`/api/media/${data.id}/progress`, {
                method: "PUT",
                body: JSON.stringify({ finished: true, watched: true }),
            }).catch(() => {
                // A record of having looked at something is a convenience; failing to store it
                // must not stop the show.
            });
        }

        go(sequence.nextId);
    }, [data?.kind, data?.id, go, sequence.nextId]);

    /**
     * What is stored right now, for the toggle, without re-binding the handler on every
     * keystroke. `data` changes identity on each refetch, and a listener that is removed and
     * re-added between a keydown and its repeat drops keys.
     */
    const ratingRef = useRef<number | null>(null);
    const favoriteRef = useRef(false);

    /**
     * What the stars and the heart show: a press still in flight, otherwise what is stored.
     *
     * The keys and the controls both read these rather than the stored values, so pressing 4
     * twice before the first has landed clears the rating -- which is what the stars on screen
     * said the second press would do. The rating needs the helper because clearing sends null
     * (see there).
     */
    const pendingOpinion = rate.isPending ? rate.variables : undefined;
    const shownRating = ratingWhilePending(data?.rating ?? null, pendingOpinion);
    const shownFavorite = pendingOpinion?.favorite ?? data?.favorite ?? false;
    ratingRef.current = shownRating;
    favoriteRef.current = shownFavorite;

    /**
     * What `Delete` can do here: open the confirmation, explain why it cannot, or nothing.
     *
     * Nothing at all without the `delete` scope, as the icon is absent then (§18.1) -- the key is
     * not one that viewer was ever told about. With the scope and a read-only root it says so
     * over the picture: the key is documented, and one that silently does nothing looks broken.
     */
    const trashRef = useRef<"allowed" | "readOnly" | null>(null);
    const trashable = !data || !hasScope("delete") ? null : data.deletable ? "allowed" : "readOnly";
    trashRef.current = trashable;

    /**
     * The answer to every rating and favourite, over the picture (§14b) -- see `StageFlash`.
     *
     * Every one, keys and clicks alike, goes through `setOpinion`, so there is one save, one
     * message and one celebration however it was given.
     *
     * Dropped when the item changes, during render rather than in an effect so the next item
     * never paints with the last one's message: a save that settles after you have moved on
     * must not appear over the next picture claiming to be about it, and coming back must not
     * replay a burst.
     */
    const [flash, setFlash] = useState<StageFlashMessage | null>(null);
    const [flashFor, setFlashFor] = useState(id);
    if (flashFor !== id) {
        setFlashFor(id);
        setFlash(null);
    }
    const flashCount = useRef(0);
    const { mutate: saveOpinion } = rate;

    const setOpinion = useCallback(
        (patch: UserMediaPatch) => {
            flashCount.current += 1;
            const key = flashCount.current;

            setFlash(
                "rating" in patch
                    ? {
                          key,
                          state: "pending",
                          subject: "rating",
                          rating: patch.rating ?? null,
                          accolade: pickAccolade(),
                      }
                    : {
                          key,
                          state: "pending",
                          subject: "favorite",
                          favorite: !!patch.favorite,
                      }
            );

            // Only the message this press put up: a later press has replaced it, and its own
            // answer is the one worth showing.
            const settle = (state: StageFlashMessage["state"]) =>
                setFlash((current) => (current?.key === key ? { ...current, state } : current));

            saveOpinion(patch, {
                onSuccess: () => settle("saved"),
                onError: () => settle("failed"),
            });
        },
        [saveOpinion]
    );

    /**
     * n and p, not the arrow keys.
     *
     * The player already owns ArrowLeft/ArrowRight for seeking and j/k/l for the transport,
     * and taking those would make the most obvious keys do the wrong thing inside a video.
     * n/p are free, and are what a set of items answers to elsewhere.
     *
     * The same guard the player uses, for the same reason: typing "next" into the search box
     * must not walk the library.
     */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            // See `isTypingTarget`: typing steps on the hotkeys, but a radio, a checkbox or a
            // slider does not — and the stars are radios, which is how the numpad that rates
            // stopped working the moment anybody rated with the mouse.
            if (isTypingTarget(event.target)) {
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return;

            // The confirmation's keys are its own: Enter confirms, Escape cancels, and n must
            // not walk the set out from under a dialog about this item. "Who is this?" likewise:
            // a search being compared is not to be thrown away by a stray n.
            if (trashOpen || whoIsThisOpen) return;

            if (event.key === "n") {
                event.preventDefault();
                go(sequence.nextId);
                return;
            }

            if (event.key === "p") {
                event.preventDefault();
                go(sequence.previousId);
                return;
            }

            /**
             * The numpad rates; the row above the letters seeks (§14b).
             *
             * Matched on `code`, because the two produce the same `key` and the player binds
             * the digits to percentage jumps. Without that distinction one keystroke would
             * both rate the item and move the playhead.
             *
             * Here rather than in the player, because a rating is a fact about the item and
             * not about playback — so it works on a photograph, which has no player at all.
             *
             * Pressing the rating you already gave takes it back, exactly as clicking the
             * star you already gave does. One rule, one function, two controls.
             */
            const numpad = /^Numpad([1-5])$/.exec(event.code);

            if (numpad && !overlayOpen) {
                event.preventDefault();
                setOpinion({
                    rating: ratingAfterPressing(Number(numpad[1]), ratingRef.current),
                });
                return;
            }

            /**
             * h for heart. The numpad was the natural neighbour for it and is full: numpad
             * `+` produces the same `key` as the main one, which the player reads as faster.
             * Here with the rating for the same reason -- it is about the item, not the
             * playback, so a photograph answers to it too.
             */
            if (event.key === "h" && !overlayOpen) {
                event.preventDefault();
                setOpinion({ favorite: !favoriteRef.current });
                return;
            }

            /**
             * Delete to trash it, then Enter to confirm (§14b).
             *
             * Backspace as well, because a Mac laptop's "delete" key sends it and there is no
             * forward Delete to press instead. Neither is a transport key, and neither
             * navigates in any browser this runs in.
             *
             * A held key repeats, and a repeat must not be the thing that answers the
             * confirmation it opened -- so only the first press counts.
             */
            if ((event.key === "Delete" || event.key === "Backspace") && !overlayOpen) {
                event.preventDefault();

                if (event.repeat) return;

                if (trashRef.current === "allowed") {
                    trashDialog.open();
                } else if (trashRef.current === "readOnly") {
                    flashCount.current += 1;
                    setFlash({
                        key: flashCount.current,
                        state: "failed",
                        subject: "refused",
                        text: "This library is read-only.",
                    });
                }
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
    }, [
        go,
        overlayOpen,
        whoIsThisOpen,
        trashOpen,
        trashDialog,
        setOpinion,
        sequence.nextId,
        sequence.previousId,
    ]);

    /**
     * The item's picture at once, while its details are still on their way (§14, "Waiting").
     *
     * Opening an item waits for the details before navigating, so this is only seen when that
     * wait ran out -- a slow NAS, a cold disk. The picture is the one the tile was showing, so it
     * is already in the browser's cache; it stands where the stage will be, lit at the edge the
     * way the pressed tile was, and gives a morph somewhere to land. Without one (a shared link,
     * a new tab) there is nothing to show yet but the loader.
     */
    if (isLoading) {
        const picture = openingPicture(id);

        return picture ? (
            <Stack gap="lg">
                {/* Where the row with the way back and the way through the set will be, so the
                    stage does not jump when it arrives. */}
                <Box h={narrow ? 36 : 26} />
                <Box className={classes.stage}>
                    <Box className={classes.frame} data-morph-stage data-opening>
                        <AspectRatio ratio={16 / 9} className={classes.standIn}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={picture} alt="" className={classes.standInPicture} />
                        </AspectRatio>
                    </Box>
                </Box>
            </Stack>
        ) : (
            <Center h={320}>
                <Loader color="brass" />
            </Center>
        );
    }

    /**
     * Why it did not load, and a way to ask again.
     *
     * "This item could not be loaded" covered a dead NAS, a deleted item and a library this
     * account cannot reach with one sentence and no way forward. The three want different
     * answers: one is worth retrying, one is not, and only one of them is anybody's fault.
     */
    if (error || !data) {
        return (
            <Stack gap="md" align="flex-start">
                <LoadFailed error={error} what="this item" onRetry={() => void refetchItem()} />
                <Anchor component={Link} href="/" size="sm">
                    Back to the library
                </Anchor>
            </Stack>
        );
    }

    // The moment a tag's menu offers as its picture: the playhead, read when the menu is
    // pressed, or the photograph itself (§6 "A tag's picture").
    const moment = {
        mediaId: data.id,
        kind: data.kind,
        atMs: () => (data.kind === "video" ? Math.round(positionRef.current) : null),
    };

    /**
     * Previous and next, in the stage's bar (§14b).
     *
     * There rather than in the row above the stage, because the bar is what is on screen in
     * fullscreen -- where a phone had no way to the next item at all. Only with a set behind the
     * item, as the position is.
     */
    const steps =
        sequence.position !== null
            ? {
                  previous: sequence.previousId ? () => go(sequence.previousId) : null,
                  next: sequence.nextId ? () => go(sequence.nextId) : null,
              }
            : null;

    /**
     * The rating and the bin, in the bar's "more" menu: in fullscreen the row under the stage is
     * gone, and without a keyboard these were out of reach there. The same save and the same
     * confirmation as the row's.
     */
    const stageMenu = (
        <>
            <Menu.Label>This item</Menu.Label>
            <Box px="sm" py={4}>
                <RatingControl
                    rating={shownRating}
                    favorite={shownFavorite}
                    onChange={setOpinion}
                    celebration={null}
                />
            </Box>
            {trashable === "allowed" && (
                <Menu.Item
                    color="oxblood"
                    leftSection={<TrashGlyph size={16} />}
                    onClick={trashDialog.open}
                >
                    Move to trash
                </Menu.Item>
            )}
        </>
    );

    return (
        <Stack gap="lg">
            {/* The way back to *where you were*, not to the front door.

                Opening an item is a detour from a particular page of a particular filter,
                scrolled to a particular place. A link to `/` throws all three away. When this
                tab arrived here from a library view, `history.back()` restores every one of
                them for free; when it did not -- a shared link, a new tab -- there is nothing
                to restore and the room is the honest destination.

                Shrink-wrapped: as a direct child of a Stack it stretched the full content
                width, making the empty strip above the player a link out of the item. */}
            <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
                {returnTo ? (
                    <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        c="dimmed"
                        underline="never"
                        w="fit-content"
                        // The stage shrinks back into the tile it came from, when that tile
                        // is on the page we return to (§14, "Motion").
                        onClick={() =>
                            morphOutOfStage(id, () =>
                                leaveViewer(returnTo, id, sequence.page, router)
                            )
                        }
                    >
                        ← Back to {returnLabel(returnTo)}
                    </Anchor>
                ) : (
                    <Anchor
                        component={Link}
                        href="/"
                        size="xs"
                        c="dimmed"
                        underline="never"
                        w="fit-content"
                    >
                        ← Home
                    </Anchor>
                )}

                {/* Where you are in the set (§14b). The way through it is in the stage's own
                    bar, at its two ends -- see `steps`.

                    Present only when there is a set: an item opened from a shared link or a
                    new tab has no filtered library behind it, and inventing one -- "the whole
                    library" -- would be a different set from the one anybody was looking at.

                    The position is hidden rather than approximated while the count is in
                    flight, and skipped entirely for a shuffled set, where the permutation
                    decides how many pages exist rather than the row count (§20). */}
                <Group gap="xs" wrap="nowrap">
                    {sequence.position !== null && sequence.total !== null && (
                        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                            {sequence.position.toLocaleString()} of{" "}
                            {sequence.total.toLocaleString()}
                        </Text>
                    )}

                    {/* How this page behaves when you arrive and when the item ends (§14b).

                        One menu beside the way through the set, rather than a row of switches
                        between the title and the item's own content. They are set once and left,
                        and a row of them got the same weight as the frames and clips below --
                        while "Play on open" came and went with the stage, sliding "Autoplay
                        next" sideways on every change between a film and a picture. In here
                        every one is always present, so none of them moves or vanishes.

                        Still not a settings page, for the reason they never were: each belongs
                        to this device rather than the account, and burying them would make them
                        harder to turn off than they were to turn on. */}
                    <Popover position="bottom-end" withinPortal shadow="md" width={280}>
                        <Popover.Target>
                            <Button
                                size={narrow ? "sm" : "compact-sm"}
                                variant="subtle"
                                color="gray"
                                leftSection={<SlidersGlyph />}
                                aria-label="Playback settings"
                                title="Playback settings"
                            >
                                {narrow ? null : "Playback"}
                            </Button>
                        </Popover.Target>
                        <Popover.Dropdown>
                            <Stack gap="md">
                                <Switch
                                    color="brass"
                                    label="Play videos on open"
                                    checked={autoplayOnOpen}
                                    onChange={(event) =>
                                        setAutoplayOnOpen(event.currentTarget.checked)
                                    }
                                />
                                <Switch
                                    color="brass"
                                    label="Autoplay next"
                                    description="Films roll on when they end; pictures after their hold"
                                    checked={autoplayNext}
                                    onChange={(event) =>
                                        setAutoplayNext(event.currentTarget.checked)
                                    }
                                />

                                {/* Only where it can apply -- see `dwellApplies`. Four values
                                    rather than a number field: one tap, and no representable
                                    value that could turn the show into a stroboscope. Present
                                    and disabled while the show is off, so the number is
                                    discoverable before it is needed. */}
                                {dwellApplies && (
                                    <Stack gap={4}>
                                        <Text size="sm">Hold each picture</Text>
                                        <SegmentedControl
                                            color="brass"
                                            fullWidth
                                            disabled={!autoplayNext}
                                            value={String(dwellSeconds)}
                                            onChange={(value) =>
                                                setDwellSeconds(snapDwellSeconds(value))
                                            }
                                            data={DWELL_CHOICES.map((seconds) => ({
                                                value: String(seconds),
                                                label: `${seconds}s`,
                                            }))}
                                        />
                                    </Stack>
                                )}
                            </Stack>
                        </Popover.Dropdown>
                    </Popover>
                </Group>
            </Group>

            {/* Above the player, not below it: the explanation has to arrive before the
                viewer has decided the app is broken. Only once this browser has refused the
                original -- until then it is being played, and may well play. */}
            {playerFailed && (
                <TranscodeNotice
                    mediaId={data.id}
                    source={data.playbackSource}
                    blockers={data.playbackBlockers}
                />
            )}

            <Box className={classes.stage} ref={stageRef}>
                {/* The morph's other end: a tile's frame grows into this box (§14, "Motion"). */}
                <Box className={classes.frame} data-morph-stage>
                    {mode === "player" ? (
                        <VideoPlayer
                            warmSource="viewer"
                            mediaId={data.id}
                            durationMs={data.durationMs}
                            startAtMs={startAtMs}
                            spriteVttUrl={data.spriteVttUrl}
                            poster={data.coverUrl}
                            autoPlay={autoplayOnOpen}
                            // Kept current so the capture button can read the playhead
                            // without this page re-rendering four times a second (§13).
                            positionRef={positionRef}
                            elementRef={elementRef}
                            preloadMediaId={warmableVideo}
                            /*
                             * Warm the part that will actually be played (§8b).
                             *
                             * Usually the beginning, but not for an item left part way earlier in
                             * this visit: the player seeks there on arrival, `preload="auto"`
                             * buffers from the element's own `currentTime`, and a warm of the
                             * opening would stall at 4:32 exactly as if it had never been warmed.
                             */
                            preloadStartMs={
                                nextDetail.data
                                    ? resumeTarget(
                                          visitPosition(nextDetail.data.id),
                                          nextDetail.data.durationMs
                                      )
                                    : null
                            }
                            span={preview}
                            onSpanEnded={() => setPreview(null)}
                            clipMarks={data.clips}
                            selection={selection}
                            onMarkIn={(atMs) =>
                                setSelection((current) => ({
                                    startMs: atMs,
                                    // Keeps an out point already past the new in point, so
                                    // nudging the start of a marked span does not clear the end.
                                    endMs:
                                        current?.endMs !== null &&
                                        current?.endMs !== undefined &&
                                        current.endMs > atMs
                                            ? current.endMs
                                            : null,
                                }))
                            }
                            onMarkOut={(atMs) =>
                                setSelection((current) =>
                                    current && atMs > current.startMs
                                        ? { ...current, endMs: atMs }
                                        : current
                                )
                            }
                            // The control and the key live with the picture; what to do
                            // with the frame is the page's business (§13).
                            onCapture={
                                data.kind === "video" ? (atMs) => capture.mutate(atMs) : undefined
                            }
                            capturing={capture.isPending}
                            captureFailed={capture.isError}
                            // Released while the enlarged view is open, or its arrows would
                            // move between frames and seek the video at the same time -- and
                            // while the trash confirmation is, whose buttons take space.
                            hotkeys={!overlayOpen && !trashOpen}
                            seekRef={seekRef}
                            // Rolling onward is a separate consent from playing what you
                            // opened, so it is a separate switch and is off by default.
                            onEnded={
                                autoplayNext && sequence.nextId
                                    ? () => go(sequence.nextId)
                                    : undefined
                            }
                            // A file that claimed it could play and then could not. The stage
                            // shows its cover instead of nothing, and the show moves on (§8b).
                            onUnplayable={() => setPlayerFailed(true)}
                            steps={steps}
                            menuItems={stageMenu}
                        />
                    ) : (
                        <StillStage
                            mediaId={data.id}
                            src={stillSource(data)}
                            alt={data.title}
                            preloadMediaId={sequence.nextId}
                            preloadSrc={warmableStill}
                            dwellMs={hold}
                            onDwellEnded={onDwellEnded}
                            dwellSeconds={dwellSeconds}
                            onDwellSeconds={setDwellSeconds}
                            // Released while the enlarged frame view or the trash confirmation
                            // is open, so nothing fights this stage for the same keystroke.
                            hotkeys={!overlayOpen && !trashOpen}
                            steps={steps}
                            menuItems={stageMenu}
                        />
                    )}
                </Box>

                <StageFlash message={flash} />
            </Box>

            {/* Title on its own line below `sm`. Anything "beside" a heading at 412px is
                underneath it anyway, and wrapping deliberately beats wrapping by accident. */}
            <Group justify="space-between" align="center" wrap="wrap" gap="md">
                {/* Clamped to two lines by the stylesheet; the whole name is the tooltip. */}
                <h1 className={classes.title} title={data.title}>
                    {data.title}
                </h1>

                {/* One height for every action on the row. On a phone they go icon-only:
                    labelled, the four overflowed a 360px screen. */}
                <Group gap={narrow ? "xs" : "md"} wrap="nowrap">
                    {/* The most frequent act on this page after playing it. */}
                    {/* Controlled by the page, which saves for it: the keys and the clicks are
                        one path, so both get the message over the picture and both make the
                        row burst (§14b). */}
                    <RatingControl
                        rating={shownRating}
                        favorite={shownFavorite}
                        onChange={setOpinion}
                        celebration={flash && isGrand(flash) ? flash : null}
                    />

                    {/* The way anything gets into a playlist (§14b). Here because this is
                        where you decide you want it -- the decision is made watching the
                        thing, not later in a list of lists. */}
                    <AddToPlaylist mediaId={data.id} iconOnly={narrow} />

                    {/* "More like this", from the moment on screen (§5e): the library ordered
                        by how much it looks like this frame -- or this photograph. The whole
                        library rather than the set you came from, which may have been narrowed
                        to something this frame has nothing to do with. */}
                    <Button
                        variant="default"
                        onClick={() =>
                            router.push(
                                `/?${viewToParams({
                                    ...DEFAULT_VIEW,
                                    mode: "grid",
                                    like:
                                        data.kind === "video"
                                            ? `${data.id}@${Math.round(positionRef.current)}`
                                            : data.id,
                                }).toString()}`
                            )
                        }
                        leftSection={narrow ? undefined : <LookAlikeGlyph size={16} />}
                        aria-label="More like this"
                        title="More like this moment"
                    >
                        {narrow ? <LookAlikeGlyph size={16} /> : "More like this"}
                    </Button>

                    {/* Who is this? (§5f): this frame's faces, found across the library.
                        Administrators', as every face surface is; a film's, being a moment. It
                        takes the keys while open, as the frame view does. */}
                    {hasScope("admin") && data.kind === "video" && mode === "player" && (
                        <WhoIsThis
                            mediaId={data.id}
                            positionRef={positionRef}
                            elementRef={elementRef}
                            iconOnly={narrow}
                            onOpenChange={setWhoIsThisOpen}
                        />
                    )}

                    <Button
                        variant="default"
                        onClick={details.open}
                        leftSection={narrow ? undefined : <InfoIcon />}
                        aria-label="Details"
                        title="Details"
                    >
                        {narrow ? <InfoIcon /> : "Details"}
                    </Button>

                    {/* The way to trash it on a phone, where there is no Delete key and the
                        drawer's button is a scroll away at the foot of everything (§10).

                        Last, and quiet -- subtle, the size of the heart -- rather than kept at
                        arm's length: the confirmation is what stands between a stray thumb and
                        the bin, and it says the item can come back. Absent without the scope or
                        on a read-only root, like every other way in (§18.1). */}
                    {trashable === "allowed" && (
                        <Tooltip
                            label={
                                <>
                                    Move to trash <Kbd size="xs">Delete</Kbd>
                                </>
                            }
                        >
                            <ActionIcon
                                variant="subtle"
                                color="oxblood"
                                size="input-sm"
                                aria-label="Move to trash"
                                aria-keyshortcuts="Delete"
                                onClick={trashDialog.open}
                            >
                                <TrashGlyph size={18} />
                            </ActionIcon>
                        </Tooltip>
                    )}
                </Group>
            </Group>

            {/* Every frame this item has (§13) -- the generated ones as well as captures.

                It appeared only once somebody had captured one, which made the frames the
                generator had already made invisible until then, and put choosing a cover
                behind the Details button. It is always here now for a film, captures first, and
                the cover is chosen here -- the Details panel no longer carries a second copy.
                A photograph is its own cover and has no strip. */}
            {data.kind === "video" && data.frames.length > 0 && (
                <Stack gap="xs">
                    <SectionLabel>Frames</SectionLabel>
                    <FrameStrip
                        mediaId={data.id}
                        frames={data.frames}
                        onSeek={seekAndShow}
                        onLightboxChange={setLightboxOpen}
                    />
                </Stack>
            )}

            {/* Marking a span, while one is being marked (§14d).

                Absent otherwise: a permanent bar with nothing in it would take a row of vertical
                space from the screen with least to spare, in order to say nothing. */}
            {selection && data.kind === "video" && (
                <ClipBar
                    selection={selection}
                    saving={createClip.isPending}
                    onClear={() => setSelection(null)}
                    onPlay={playSpan}
                    onSave={(input) => createClip.mutate({ mediaId: data.id, input })}
                />
            )}

            {/* This viewer's spans of this item, in timeline order (§14d). */}
            {data.clips.length > 0 && (
                <ClipStrip
                    clips={data.clips}
                    coverUrl={data.coverUrl}
                    onPlay={(clip) =>
                        playSpan({ startMs: clip.startMs, endMs: clip.endMs, speed: clip.speed })
                    }
                />
            )}

            {/* What you write about it (§14b): each facet, then the note.

                After everything the item already has and before where to go next -- they are
                about this item, and Up next is the way off it. On the page rather than in the
                Details drawer, which covered the film while you described it. Each facet has
                its own heading rather than sharing a "Tags" one: they are one mechanism, but
                the navigation treats Performers, Sources and Keywords as separate things and
                so does this. The note is keyed by the item because Prev and Next reuse this
                page, and a draft must not follow you onto the next one. */}
            {/* Performers across the page's width, the rest beside the note: who is tagged and
                who the faces found in it are one list (§5f "People in this item"), with room for
                a card each and, for administrators, who else may be in it. */}
            <ItemPerformers
                mediaId={data.id}
                values={data.tags.filter((tag) => tag.kind === "performer" && !tag.private)}
                faces={hasScope("admin")}
                moment={moment}
                onSeek={seekAndShow}
            />

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg" verticalSpacing="lg">
                <TagEditor
                    mediaId={data.id}
                    tags={data.tags}
                    except={["performer"]}
                    moment={moment}
                />
                <Stack gap="xs">
                    <SectionLabel>Note</SectionLabel>
                    <MediaNote key={data.id} mediaId={data.id} note={data.note} />
                </Stack>
            </SimpleGrid>

            {/* What is coming, and whether to go there by itself (§14b).

                Below the title rather than under the player: the player and its name are
                what the page is for, and a filmstrip wedged between them pushes the title
                off a phone screen. Absent entirely when there is nothing after this item, so
                the last item of a set does not carry an empty shelf.

                The autoplay switches used to sit in this header, on the grounds that they
                were about this strip. They are in the Playback menu now -- see there for why. */}
            {sequence.upcoming.length > 0 && (
                <Stack gap="xs">
                    <SectionLabel>Up next</SectionLabel>

                    <Group gap="sm" wrap="nowrap" className={classes.upNext}>
                        {sequence.upcoming.map((item) => (
                            <Box
                                key={item.id}
                                component="button"
                                type="button"
                                className={classes.upNextItem}
                                onClick={() => go(item.id)}
                                title={item.title}
                            >
                                {item.coverUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={item.coverUrl}
                                        alt=""
                                        loading="lazy"
                                        decoding="async"
                                    />
                                ) : (
                                    <Box className={classes.upNextBlank} />
                                )}
                                <Text size="xs" lineClamp={1}>
                                    {item.title}
                                </Text>
                            </Box>
                        ))}
                    </Group>
                </Stack>
            )}

            {/* The panel can send the player to a moment -- a text finding carries the
                position it was read from, and checking one means looking at that frame. */}
            <MediaDetailsDrawer
                detail={data}
                opened={detailsOpen}
                onClose={details.close}
                onSeek={seekAndShow}
                onTrash={trashable === "allowed" ? trashDialog.open : null}
            />

            {/* Only for somebody who can use it: it fetches the item's copies ahead of being
                opened (see there), which nobody else needs. Keyed by the item, because this
                page survives stepping to the next one and the ticks belong to this one. */}
            {trashable === "allowed" && (
                <TrashConfirm
                    key={data.id}
                    opened={trashOpen}
                    onClose={trashDialog.close}
                    mediaId={data.id}
                    title={data.title}
                    duplicate={data.duplicate}
                    onDeleted={afterDelete}
                />
            )}
        </Stack>
    );
};

export default MediaPage;
