"use client";

import { useEffect, useId, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useProcessingStatus } from "@/components/admin/ProcessingProgress";
import { SealMark } from "@/components/shell/SealMark";
import { useAuth } from "@/lib/api/AuthProvider";
import { useLibraryStats } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";

import classes from "./BusySeal.module.scss";

/**
 * The header's seal, with a cork ring that turns round it while the worker is busy (§14,
 * "Motion").
 *
 * An honest activity light rather than a spinner: it appears only while something is actually
 * being done, names what -- scanning or processing -- and fades when the work runs out. It is
 * decoration over a signal that already exists, so the ring is hidden from assistive technology
 * and the header's "Scanning" badge stays the thing that is announced.
 *
 * **Busy means working now**: a scan running, or a job claimed by the worker. Not "stages with
 * work left" -- a stage that cannot run here (no model, nothing applicable) keeps a remainder
 * for ever, and the ring would never stop -- and not "jobs pending", which is also what a
 * paused queue looks like.
 *
 * Everybody sees a scan, from the stats the shell already polls. Only an administrator sees
 * processing, because only they can read the queue -- and that query stops polling when the
 * queue goes idle, so nothing would notice the jobs a scan queues as it finishes. A scan's end
 * is when they are queued, so that is when the queue is asked again.
 */
const RING_R = 80;
const RING_LENGTH = 2 * Math.PI * RING_R;

export const BusySeal: React.FC<{ size: number }> = ({ size }) => {
    const ringId = `busy-ring-${useId().replace(/:/g, "")}`;
    const { hasScope } = useAuth();
    const admin = hasScope("admin");
    const scanning = useLibraryStats().data?.scanning ?? false;
    const { data: processing } = useProcessingStatus();
    const queryClient = useQueryClient();

    const wasScanning = useRef(scanning);
    useEffect(() => {
        if (admin && wasScanning.current !== scanning) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.admin.processing() });
        }
        wasScanning.current = scanning;
    }, [admin, scanning, queryClient]);

    const working =
        admin && processing ? processing.scan !== null || processing.queue.claimed > 0 : false;
    const busy = scanning || working;
    const word = scanning || processing?.scan ? "SCANNING" : "PROCESSING";

    return (
        <span
            className={`${classes.seal} ${busy ? classes.busy : ""}`}
            style={{ width: size, height: size }}
        >
            <SealMark size={size} />
            <svg className={classes.ring} viewBox="0 0 200 200" aria-hidden focusable="false">
                <defs>
                    <path
                        id={ringId}
                        d={`M100,100 m-${RING_R},0 a${RING_R},${RING_R} 0 1,1 ${2 * RING_R},0 a${RING_R},${RING_R} 0 1,1 -${2 * RING_R},0`}
                    />
                </defs>
                <g className={classes.turn}>
                    {/* Twice round the word, spaced to close the ring exactly. */}
                    <text className={classes.words}>
                        <textPath
                            href={`#${ringId}`}
                            textLength={RING_LENGTH}
                            lengthAdjust="spacing"
                        >
                            {`${word} · ${word} · `}
                        </textPath>
                    </text>
                </g>
            </svg>
        </span>
    );
};
