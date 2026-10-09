/**
 * Turning what many frames said into one answer (§5d).
 *
 * A watermark is read slightly differently in every frame it appears in — `PRIVATE STOCK`,
 * `PRIVATE ST0CK`, `PRlVATE STOCK`. Storing those as three strings splits the occurrence
 * count across a single object's own misreadings, which defeats the recurrence argument at
 * exactly the input it was meant to be strongest on. So observations are reconciled before
 * anything is stored.
 *
 * Pure, and deliberately the first part of OCR to be written. It needs no database, no
 * ffmpeg and no recognition engine, it holds all the logic that is actually hard, and it can
 * be tested exhaustively against fixtures that state what the frames said.
 */

/** One line of text as the engine read it, in one frame. */
export interface TextObservation {
    /** Where in the source this frame came from. */
    atMs: number;
    text: string;
    /** 0–1, as the engine reported it. */
    confidence: number;
    /**
     * Where on the frame, as fractions of its width and height.
     *
     * Fractions rather than pixels so that the same watermark in a 1080p file and a 720p
     * one compares equal — and so a change to the pre-OCR scaling does not silently stop
     * grouping anything.
     */
    box: TextBox;
}

export interface TextBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** One string, as reconciled across every frame it appeared in. */
export interface ReconciledText {
    /** The elected reading. May be one no single frame produced. */
    text: string;
    /** Folded and normalised, for matching against tags and other items. */
    textNorm: string;
    firstAtMs: number;
    lastAtMs: number;
    /** Confidence of the elected reading, 0–1. */
    confidence: number;
    /** Frames this string appeared in. */
    occurrences: number;
    /**
     * Fraction of sampled frames it appeared in, 0–1.
     *
     * The number that actually means something. A raw count is not comparable between a
     * three-minute clip and a three-hour film, and this is what separates a site watermark
     * (high, fixed box) from a title card (low, early) without storing either judgement.
     */
    stability: number;
    /** Mean box across the observations, for drawing and for later matching. */
    box: TextBox;
}

export interface ReconcileOptions {
    /** Box overlap (IoU) above which two observations are the same object. */
    boxOverlapMin?: number;
    /** Similarity above which two readings in one place are the same string. */
    similarityMin?: number;
    /** Observations a cluster needs before a character vote is trusted. */
    voteMin?: number;
    /** Shortest elected string worth keeping. */
    minLength?: number;
    /**
     * Whether a fragment is folded into the string it is a fragment of.
     *
     * On by default. It exists as a switch because it is a *judgement* about what recognition
     * does, and the only way to find out whether a judgement is helping is to measure a real
     * library with it on and off — `scripts/ocr-calibrate.mjs` reports both.
     */
    absorb?: boolean;
}

export const OCR_BOX_OVERLAP_MIN = 0.5;
export const OCR_SIMILARITY_MIN = 0.72;
export const OCR_VOTE_MIN = 3;

/**
 * Shortest string worth keeping, measured rather than guessed.
 *
 * On a real library three quarters of everything recognised was one or two characters:
 * fragments of graphics, compression artefacts, single letters lifted out of a texture.
 * Burned-in metadata — a studio name, a URL, a name card — is essentially never that short,
 * so this one rule removes most of the noise before any other threshold is consulted.
 *
 * Four rather than three, decided by reading the output on a real library rather than by
 * reasoning about it. Three-letter identifiers are real and this does lose them — a
 * broadcaster's initials are exactly the sort of thing worth finding — but on the measured
 * distribution almost everything at three characters was noise, and a floor is only worth
 * having if it is set where the noise actually is. Recovering those initials is a job for a
 * better reading of the frame, not for admitting a band that is overwhelmingly junk.
 */
export const OCR_MIN_LENGTH = 4;

/**
 * What a finding must clear to be stored at all.
 *
 * Measured against the rows a person confirmed were the right ones, on files they could see
 * and this code cannot. The weakest true finding read 0.54 across two frames, so the floor
 * sits a little under it: recognition jitter of a few hundredths must not be the difference
 * between a watermark being catalogued and vanishing.
 *
 * **Corroboration, not stability.** Stability is occurrences over frames sampled, so the same
 * evidence scores differently by file length — one of the confirmed findings scores 0.29 on a
 * seven-frame file and would have scored 0.05 on the forty-frame files beside it. Gating on
 * it would discard real text for a reason that has nothing to do with the text. Stability is
 * how a permanent watermark separates from a title card, which makes it a ranking signal;
 * whether a row exists is decided by whether more than one frame saw it.
 *
 * Erring low is deliberate and asymmetric: a junk row is visible in the details panel,
 * dismissible, and weighted below curated metadata in search, while text that was never
 * stored is invisible and there is nothing to notice.
 *
 * 0.5 since the production calibration of 2026-10-02 (§5d "Settings and the test bench"), up
 * from 0.45 -- still under that weakest confirmed 0.54.
 */
export const OCR_CONFIDENCE_MIN = 0.5;
export const OCR_OCCURRENCES_MIN = 2;

/**
 * Is this finding worth a row?
 *
 * Kept out of `reconcileText` on purpose. Reconciliation answers "what did the frames say",
 * and calibration needs that answer whole — a survey that could only see what survived the
 * floor could never show where the floor should be.
 */
export const isWorthStoring = (
    row: ReconciledText,
    floors: { confidenceMin: number; occurrencesMin: number } = {
        confidenceMin: OCR_CONFIDENCE_MIN,
        occurrencesMin: OCR_OCCURRENCES_MIN,
    }
): boolean => row.confidence >= floors.confidenceMin && row.occurrences >= floors.occurrencesMin;

/**
 * How much of a smaller box must lie inside a larger one to be the same object.
 *
 * Containment rather than overlap, because a fragment is *inside* the thing it is a
 * fragment of: "ite.com" read out of "example-site.com" shares its position but covers a
 * fraction of its area, so intersection-over-union reads low exactly when the two are most
 * obviously the same text.
 */
export const OCR_CONTAINMENT_MIN = 0.7;

/**
 * Glyphs recognition confuses, folded to one representative.
 *
 * Used **only to decide whether two readings are the same string**. It never rewrites what
 * is stored: folding `0` onto `O` is a claim about what the engine tends to get wrong, not
 * about what the text says, and a URL or a serial number would be corrupted by applying it
 * to the output.
 */
const CONFUSABLE: Record<string, string> = {
    "0": "o",
    "1": "l",
    i: "l",
    "5": "s",
    "8": "b",
    "2": "z",
    "6": "g",
    "9": "g",
};

/**
 * Lowercase, fold accents and confusables, collapse runs of non-alphanumerics to one space.
 *
 * Accents fold before the ASCII filter rather than falling to it: `Zoë` used to become `zo`,
 * which no name matched and which every other word lost a letter to (§5b "One rule for names").
 */
export const foldForComparison = (text: string): string =>
    text
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split("")
        .map((character) => CONFUSABLE[character] ?? character)
        .join("")
        // `rn` is read as `m` often enough to be worth folding, and the reverse is rare
        // enough that collapsing both onto one representative loses nothing.
        .replace(/rn/g, "m");

/**
 * The stored normalised form: lowercased and whitespace-collapsed, and nothing else.
 *
 * Distinct from `foldForComparison` on purpose. This one has to survive being matched
 * against a tag name a person typed, so it must not claim that `st0ck` and `stock` are the
 * same word — only the grouping step is allowed to believe that.
 */
export const normalizeText = (text: string): string =>
    text.toLowerCase().replace(/\s+/g, " ").trim();

/** Intersection over union of two boxes, 0 when they do not overlap at all. */
export const boxOverlap = (a: TextBox, b: TextBox): number => {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);

    if (right <= left || bottom <= top) {
        return 0;
    }

    const intersection = (right - left) * (bottom - top);
    const union = a.w * a.h + b.w * b.h - intersection;

    return union <= 0 ? 0 : intersection / union;
};

/** Fraction of `inner` that lies within `outer`, 0 when they do not meet. */
export const boxContainment = (inner: TextBox, outer: TextBox): number => {
    const left = Math.max(inner.x, outer.x);
    const top = Math.max(inner.y, outer.y);
    const right = Math.min(inner.x + inner.w, outer.x + outer.w);
    const bottom = Math.min(inner.y + inner.h, outer.y + outer.h);

    if (right <= left || bottom <= top) {
        return 0;
    }

    const area = inner.w * inner.h;

    return area <= 0 ? 0 : ((right - left) * (bottom - top)) / area;
};

/** Levenshtein distance, with the usual two-row optimisation. */
const editDistance = (a: string, b: string): number => {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];

        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }

        previous = current;
    }

    return previous[b.length];
};

/** 1 for identical, 0 for nothing in common. Length-relative, so short strings are strict. */
export const similarity = (a: string, b: string): number => {
    const longest = Math.max(a.length, b.length);

    return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
};

/**
 * The reading a cluster agrees on.
 *
 * A confidence-weighted vote per character rather than "take the most confident reading",
 * and the difference is the whole reason for sampling more than one frame: three readings
 * that are each wrong in a different place can vote for a string none of them produced.
 *
 * Only readings of the **modal length** vote. Aligning readings of different lengths needs
 * a full alignment pass, and the common case does not call for one — OCR jitter on a static
 * watermark substitutes characters far more often than it inserts or drops them. A reading
 * of another length still counts as an occurrence and still contributes its confidence to
 * the cluster; it simply does not get a say in the spelling.
 *
 * Below `voteMin` observations there is nothing to corroborate, so the most confident
 * reading is taken as it stands.
 *
 * **It recovers the truth only when the misreadings are distributed.** A vote reports the
 * majority, so it fixes a character that most frames got right and cannot fix one that most
 * frames got wrong in the same way — a watermark over a busy background may be misread
 * identically every time, and no amount of sampling turns that into a correct reading. That
 * is a real limit rather than a bug, and it is why confidence is kept alongside the text
 * rather than discarded once a cluster has agreed.
 */
export const electText = (
    observations: TextObservation[],
    voteMin: number = OCR_VOTE_MIN
): { text: string; confidence: number } => {
    const best = observations.reduce((winner, observation) =>
        observation.confidence > winner.confidence ? observation : winner
    );

    if (observations.length < voteMin) {
        return { text: best.text, confidence: best.confidence };
    }

    // Modal length, breaking a tie on total confidence rather than on iteration order.
    const byLength = new Map<number, { count: number; weight: number }>();

    for (const observation of observations) {
        const entry = byLength.get(observation.text.length) ?? { count: 0, weight: 0 };

        entry.count += 1;
        entry.weight += observation.confidence;
        byLength.set(observation.text.length, entry);
    }

    let length = best.text.length;

    for (const [candidate, entry] of byLength) {
        const winner = byLength.get(length);

        if (!winner || entry.count > winner.count) {
            length = candidate;
        } else if (entry.count === winner.count && entry.weight > winner.weight) {
            length = candidate;
        }
    }

    const voters = observations.filter((observation) => observation.text.length === length);

    if (voters.length < voteMin) {
        return { text: best.text, confidence: best.confidence };
    }

    let elected = "";

    for (let position = 0; position < length; position += 1) {
        const weights = new Map<string, number>();

        for (const voter of voters) {
            const character = voter.text[position];

            weights.set(character, (weights.get(character) ?? 0) + voter.confidence);
        }

        let winner = "";
        let winning = -1;

        for (const [character, weight] of weights) {
            if (weight > winning) {
                winner = character;
                winning = weight;
            }
        }

        elected += winner;
    }

    return {
        text: elected,
        // The cluster's best, not the mean: the elected string is at least as good as the
        // reading it came from, and averaging in the blurred frames would understate it.
        confidence: Math.max(...voters.map((voter) => voter.confidence)),
    };
};

const meanBox = (observations: TextObservation[]): TextBox => ({
    x: observations.reduce((total, o) => total + o.box.x, 0) / observations.length,
    y: observations.reduce((total, o) => total + o.box.y, 0) / observations.length,
    w: observations.reduce((total, o) => total + o.box.w, 0) / observations.length,
    h: observations.reduce((total, o) => total + o.box.h, 0) / observations.length,
});

/**
 * Every observation across every sampled frame, reduced to one row per distinct string.
 *
 * Two passes, strongest signal first.
 *
 * **Position**, because it does not depend on the text having been read correctly at all. A
 * watermark holds the same box in every frame, so observations whose boxes overlap are the
 * same object however badly any one of them was recognised — which is a far better grouping
 * key than the string, and free from the same engine call.
 *
 * **Then similarity within that position**, so that genuinely different text appearing in
 * the same corner — a rotating caption, a timestamp burn-in — does not collapse into one
 * string just because it shares a location.
 *
 * `framesSampled` is what makes `stability` meaningful and must be the number of frames
 * actually examined, not the number that produced text.
 */
export const reconcileText = (
    observations: TextObservation[],
    framesSampled: number,
    options: ReconcileOptions = {}
): ReconciledText[] => {
    const boxOverlapMin = options.boxOverlapMin ?? OCR_BOX_OVERLAP_MIN;
    const similarityMin = options.similarityMin ?? OCR_SIMILARITY_MIN;
    const voteMin = options.voteMin ?? OCR_VOTE_MIN;
    const minLength = options.minLength ?? OCR_MIN_LENGTH;
    const absorb = options.absorb ?? true;

    const clusters: {
        folded: string;
        box: TextBox;
        /** Readings that formed this cluster. These, and only these, vote on the spelling. */
        members: TextObservation[];
        /** Readings folded in from a fragment: evidence that it was there, nothing more. */
        adopted: TextObservation[];
        absorbed?: boolean;
    }[] = [];

    for (const observation of observations) {
        const folded = foldForComparison(observation.text);

        if (folded === "") {
            // Punctuation and stray marks read as text. Nothing to match and nothing worth
            // indexing, so it is dropped rather than stored as an empty string.
            continue;
        }

        const match = clusters.find(
            (cluster) =>
                boxOverlap(cluster.box, observation.box) >= boxOverlapMin &&
                similarity(cluster.folded, folded) >= similarityMin
        );

        if (match) {
            match.members.push(observation);
            // The running box follows the members, so a cluster that drifts slightly across
            // frames keeps matching rather than splitting halfway through.
            match.box = meanBox(match.members);
        } else {
            clusters.push({
                folded,
                box: observation.box,
                members: [observation],
                adopted: [],
            });
        }
    }

    /**
     * A fragment of a string is not a second finding.
     *
     * Recognition routinely reports both "example-site.com" and the "ite.com" it managed on
     * a worse frame. They share a position and one contains the other, so they are one
     * object read twice — and reporting both makes the shorter compete with the longer for
     * the reader's attention while splitting the evidence between them.
     *
     * The longer keeps the union of the frames, not the sum: the two were usually read from
     * the *same* frames, so adding the counts would claim more corroboration than exists.
     *
     * **What is absorbed corroborates but does not vote.** A fragment is evidence that the
     * object was on screen in that frame; it is not evidence about how the object is spelled,
     * because the one thing already known about it is that it is a *partial* reading. Letting
     * absorbed readings into the character vote loses the string absorption exists to
     * protect, and loses it in the common case rather than a rare one: a watermark that is
     * only sometimes read in full is read in part more often than in full, so the fragments
     * arrive as the majority, carry the modal length, and elect themselves. Measured on a
     * real file -- the two most frequently recognised strings were both substrings of the
     * correct third, and the merge handed them the election and destroyed it.
     */
    for (const cluster of absorb
        ? [...clusters].sort((a, b) => b.folded.length - a.folded.length)
        : []) {
        if (cluster.absorbed) continue;

        for (const other of clusters) {
            if (
                other === cluster ||
                other.absorbed ||
                other.folded.length >= cluster.folded.length ||
                !cluster.folded.includes(other.folded) ||
                boxContainment(other.box, cluster.box) < OCR_CONTAINMENT_MIN
            ) {
                continue;
            }

            other.absorbed = true;

            const seen = new Set(
                [...cluster.members, ...cluster.adopted].map((member) => member.atMs)
            );

            for (const member of [...other.members, ...other.adopted]) {
                if (!seen.has(member.atMs)) {
                    cluster.adopted.push(member);
                    seen.add(member.atMs);
                }
            }
        }
    }

    return clusters
        .filter((cluster) => !cluster.absorbed)
        .map((cluster): ReconciledText | null => {
            const elected = electText(cluster.members, voteMin);

            /**
             * Length is judged on the *elected* string, after the vote.
             *
             * The same rule the confidence floor follows, and for the same reason: dropping
             * short observations first would throw away the readings that corroborate. A
             * two-character misreading of a real word belongs in the vote that corrects it,
             * not in the bin before the vote happens.
             */
            if (elected.text.trim().length < minLength) {
                return null;
            }

            // Occurrence and timespan count every frame the object was seen in, absorbed
            // fragments included -- they are what the recurrence argument is made of.
            const attested = [...cluster.members, ...cluster.adopted];
            const times = attested.map((member) => member.atMs);

            return {
                text: elected.text,
                textNorm: normalizeText(elected.text),
                firstAtMs: Math.min(...times),
                lastAtMs: Math.max(...times),
                confidence: elected.confidence,
                occurrences: attested.length,
                stability: framesSampled > 0 ? Math.min(1, attested.length / framesSampled) : 0,
                box: cluster.box,
            };
        })
        .filter((row): row is ReconciledText => row !== null)
        .sort(
            (left, right) => right.stability - left.stability || left.firstAtMs - right.firstAtMs
        );
};

/**
 * How many frames to read, and where (§5d).
 *
 * Three passes, and the arithmetic is the reason there are three. Most files carry no
 * burned-in text at all, so the strategy spends almost nothing on them and stops early on the
 * rest: the probe is the exit for the majority of a library and the single largest cost
 * decision in the feature.
 *
 * Pure, so the plan can be asserted against durations without an engine or a file. The
 * constants are the defaults; an administrator can change each of them (§5d "Settings").
 */
export const OCR_PROBE_FRAMES = 6;
/**
 * Where title and name cards live.
 *
 * The burst competes with the sweep for the frame cap, which is why it is short: the cards are
 * at the front or they are not cards, and every frame spent re-reading one is a frame the pass
 * with hours to cover does not get. It began at sixty seconds every two -- itself cut from
 * ninety, which at that rate was forty-five frames and left a two-hour film twelve for its
 * watermark. Since the production calibration of 2026-10-02 (§5d "Settings and the test
 * bench") it is thirty seconds every three: ten frames, against a cap of forty.
 */
export const OCR_BURST_WINDOW_MS = 30_000;
export const OCR_BURST_EVERY_MS = 3_000;
/**
 * A watermark is everywhere, so it does not need looking for often. Five minutes and forty
 * frames since the production calibration, from three minutes and sixty.
 */
export const OCR_SWEEP_EVERY_MS = 300_000;
export const OCR_MAX_FRAMES = 40;
/**
 * Occurrences after which sweeping adds count and no information.
 *
 * The sweep exists to establish that a string persists. Once it has, more of the same frame
 * changes no decision the reconciler or the search index will make, so the pass stops.
 */
export const OCR_CONFIRMED_OCCURRENCES = 6;

export interface FramePlan {
    /** Read first. Nothing recurring here and the item is done. */
    probe: number[];
    /** Read only if the probe found something. */
    burst: number[];
    /** Read last, and abandoned as soon as a string is confirmed. */
    sweep: number[];
}

/**
 * Positions to sample, in milliseconds.
 *
 * The probe splits its frames between the opening — where a title card would be, and so the
 * place a single frame is most likely to be worth reading — and the body, so that a file
 * whose only text is a watermark is not eliminated for having an unmarked first minute.
 *
 * A still has one frame and no timeline; it is planned as a single position at zero and the
 * later passes have nothing to add.
 */
/** The levers the frame plan reads, which an administrator can set (§5d "Settings"). */
export interface OcrSampling {
    probeFrames: number;
    burstSeconds: number;
    burstEverySeconds: number;
    sweepEverySeconds: number;
    maxFrames: number;
}

const DEFAULT_SAMPLING: OcrSampling = {
    probeFrames: OCR_PROBE_FRAMES,
    burstSeconds: OCR_BURST_WINDOW_MS / 1000,
    burstEverySeconds: OCR_BURST_EVERY_MS / 1000,
    sweepEverySeconds: OCR_SWEEP_EVERY_MS / 1000,
    maxFrames: OCR_MAX_FRAMES,
};

export const ocrFramePlan = (
    durationMs: number | null,
    sampling: OcrSampling = DEFAULT_SAMPLING
): FramePlan => {
    const probeFrames = sampling.probeFrames;
    const burstWindowMs = sampling.burstSeconds * 1000;
    const burstEveryMs = sampling.burstEverySeconds * 1000;
    const sweepEveryMs = sampling.sweepEverySeconds * 1000;

    if (!durationMs || durationMs <= 0) {
        return { probe: [0], burst: [], sweep: [] };
    }

    const opening = Math.ceil(probeFrames / 2);
    const inOpening = Array.from({ length: opening }, (_, i) =>
        Math.round((Math.min(30_000, durationMs) / opening) * i)
    );
    const inBody = Array.from({ length: probeFrames - opening }, (_, i) =>
        Math.round((durationMs / (probeFrames - opening + 1)) * (i + 1))
    );

    const probe = [...new Set([...inOpening, ...inBody])]
        .filter((at) => at < durationMs)
        .sort((a, b) => a - b);

    const burst = Array.from(
        { length: Math.floor(Math.min(durationMs, burstWindowMs) / burstEveryMs) },
        (_, i) => i * burstEveryMs
    ).filter((at) => at < durationMs && !probe.includes(at));

    const sweep = Array.from(
        { length: Math.floor(durationMs / sweepEveryMs) },
        (_, i) => (i + 1) * sweepEveryMs
    ).filter((at) => at < durationMs && !probe.includes(at) && !burst.includes(at));

    // The cap is on frames *read*, and the probe has already been counted against it: a plan
    // that promised more than the cap would have the handler silently stop mid-pass instead.
    const remaining = Math.max(0, sampling.maxFrames - probe.length);

    return {
        probe,
        burst: burst.slice(0, remaining),
        sweep: sweep.slice(0, Math.max(0, remaining - Math.min(burst.length, remaining))),
    };
};

/**
 * What a re-run needs to know about a finding somebody has already reviewed (§5d).
 *
 * `originalText` is the engine's reading before a correction, and null when there was none.
 * The box is null where nothing was recorded.
 */
export interface ReviewedText {
    text: string;
    originalText: string | null;
    box: TextBox | null;
}

/**
 * Drop the new findings that a reviewed one already accounts for.
 *
 * A re-run replaces only unreviewed findings, so without this the same watermark would be read
 * again and come back beside the reviewed row: a dismissed string reappearing, and a corrected
 * one shown twice, once corrected and once misread.
 *
 * Accounted for means either:
 *
 *  - **The same text**, normalised, as the reviewed row's current or original reading. That
 *    catches the engine misreading the same way twice, which it usually does.
 *  - **The same place, much the same text.** Boxes overlapping as the reconciler requires of one
 *    object, and folded readings as similar as it requires of one string. That catches a
 *    misreading that differs from last time's by a character, which the first rule cannot.
 *
 * Both rules are the reconciler's own thresholds, so "this is the string you reviewed" means
 * the same here as "these frames saw the same string" does there.
 */
export const keepReviewed = <T extends { text: string; box: TextBox | null }>(
    findings: T[],
    reviewed: ReviewedText[]
): T[] => {
    if (reviewed.length === 0) {
        return findings;
    }

    const readings = reviewed.map((row) => {
        const texts = [row.text, ...(row.originalText ? [row.originalText] : [])];

        return {
            normalized: new Set(texts.map(normalizeText)),
            folded: texts.map(foldForComparison),
            box: row.box,
        };
    });

    return findings.filter((finding) => {
        const normalized = normalizeText(finding.text);
        const folded = foldForComparison(finding.text);

        return !readings.some(
            (reading) =>
                reading.normalized.has(normalized) ||
                (reading.box !== null &&
                    finding.box !== null &&
                    boxOverlap(reading.box, finding.box) >= OCR_BOX_OVERLAP_MIN &&
                    reading.folded.some((text) => similarity(text, folded) >= OCR_SIMILARITY_MIN))
        );
    });
};
