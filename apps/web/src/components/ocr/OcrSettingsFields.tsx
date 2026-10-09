import {
    Accordion,
    Group,
    NumberInput,
    Select,
    SimpleGrid,
    Switch,
    Text,
    Tooltip,
} from "@mantine/core";

import { OCR_PAGE_MODES, type OcrSettings } from "@private-stock/core";

import { InfoGlyph } from "@/components/media/Glyph";

const PAGE_MODE_LABELS: Record<number, string> = {
    6: "6 — one block of text",
    11: "11 — sparse text, anywhere (default)",
    12: "12 — sparse text, with orientation",
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** A field's label with its explanation behind a hover, rather than a line under every box. */
const Labelled: React.FC<{ label: string; help: string }> = ({ label, help }) => (
    <Group gap={4} wrap="nowrap" component="span">
        <span>{label}</span>
        <Tooltip label={help} multiline w={260} withArrow>
            <Text span c="dimmed" display="inline-flex" aria-label={help}>
                <InfoGlyph size={13} />
            </Text>
        </Tooltip>
    </Group>
);

type Key = keyof OcrSettings;

/**
 * The three groups, each with what its header says while it is closed.
 *
 * The summary is the point of collapsing: a closed group still says what it is set to, so
 * nobody has to open three panels to find out whether anything is unusual.
 */
const GROUPS: {
    value: string;
    title: string;
    keys: Key[];
    summary: (settings: OcrSettings) => string;
}[] = [
    {
        value: "kept",
        title: "What is kept",
        keys: ["confidenceMin", "occurrencesMin", "minLength"],
        summary: (s) =>
            `≥ ${percent(s.confidenceMin)} confident · ${s.occurrencesMin}+ frames · ${s.minLength}+ characters`,
    },
    {
        value: "frames",
        title: "Which frames are read",
        keys: [
            "probeFrames",
            "burstSeconds",
            "burstEverySeconds",
            "sweepEverySeconds",
            "maxFrames",
            "confirmedOccurrences",
        ],
        summary: (s) =>
            `${s.probeFrames} to start · first ${s.burstSeconds}s every ${s.burstEverySeconds}s · then every ${s.sweepEverySeconds}s · at most ${s.maxFrames}`,
    },
    {
        value: "read",
        title: "How each frame is read",
        keys: ["psm", "frameWidth", "contrast"],
        summary: (s) =>
            `layout ${s.psm} · ${s.frameWidth}px · faint text ${s.contrast ? "boosted" : "as is"}`,
    },
];

interface OcrSettingsFieldsProps {
    value: OcrSettings;
    defaults: OcrSettings;
    onChange: (next: OcrSettings) => void;
}

/**
 * The OCR settings as a form (§5d "Settings and the test bench").
 *
 * Collapsed by default, each group summarised on its header and marked where it differs from
 * the defaults. Twelve numbers with twelve explanations open at once read as a cockpit; most
 * visits change one of them, and the summary says which group it is in.
 */
export const OcrSettingsFields: React.FC<OcrSettingsFieldsProps> = ({
    value,
    defaults,
    onChange,
}) => {
    const set = <K extends Key>(key: K, next: OcrSettings[K]): void =>
        onChange({ ...value, [key]: next });

    const number = (
        key: Key,
        label: string,
        help: string,
        options: { min: number; max: number; step?: number; decimal?: boolean }
    ) => (
        <NumberInput
            label={<Labelled label={label} help={help} />}
            value={value[key] as number}
            onChange={(next) => typeof next === "number" && set(key, next as never)}
            min={options.min}
            max={options.max}
            step={options.step ?? 1}
            decimalScale={options.decimal ? 2 : 0}
            allowDecimal={options.decimal ?? false}
            placeholder={String(defaults[key])}
        />
    );

    const fields: Record<string, React.ReactNode> = {
        kept: (
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
                {number(
                    "confidenceMin",
                    "Minimum confidence",
                    "0 to 1. Higher keeps less junk and loses faint text. A reading below a floor is thrown away, so lowering one only shows more on items read again.",
                    { min: 0, max: 1, step: 0.05, decimal: true }
                )}
                {number(
                    "occurrencesMin",
                    "Minimum frames",
                    "A string seen in fewer frames is dropped.",
                    {
                        min: 1,
                        max: 30,
                    }
                )}
                {number("minLength", "Minimum length", "Shorter strings are almost always noise.", {
                    min: 1,
                    max: 20,
                })}
            </SimpleGrid>
        ),
        frames: (
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
                {number(
                    "probeFrames",
                    "First-pass frames",
                    "Decides whether an item has text at all. Most items stop here.",
                    { min: 2, max: 30 }
                )}
                {number(
                    "burstSeconds",
                    "Opening read closely (s)",
                    "Where title and name cards are.",
                    { min: 0, max: 600 }
                )}
                {number(
                    "burstEverySeconds",
                    "Opening interval (s)",
                    "One frame every this many seconds in the opening.",
                    { min: 1, max: 60 }
                )}
                {number(
                    "sweepEverySeconds",
                    "Rest of item, every (s)",
                    "Looking for a watermark that persists.",
                    { min: 10, max: 3600 }
                )}
                {number("maxFrames", "Most frames per item", "A ceiling, whatever the length.", {
                    min: 6,
                    max: 300,
                })}
                {number(
                    "confirmedOccurrences",
                    "Stop once seen in",
                    "Frames that settle a string; reading stops there.",
                    { min: 2, max: 60 }
                )}
            </SimpleGrid>
        ),
        read: (
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <Select
                    label={<Labelled label="Layout mode" help="Tesseract's page segmentation." />}
                    data={OCR_PAGE_MODES.map((mode) => ({
                        value: String(mode),
                        label: PAGE_MODE_LABELS[mode],
                    }))}
                    value={String(value.psm)}
                    onChange={(next) => next && set("psm", Number(next))}
                    allowDeselect={false}
                />
                {number(
                    "frameWidth",
                    "Frame width (px)",
                    "Wider is slower, and not always better.",
                    { min: 640, max: 3840, step: 160 }
                )}
                <Switch
                    mt={{ base: 0, sm: 30 }}
                    color="brass"
                    label={
                        <Labelled
                            label="Boost faint text"
                            help="A strong contrast stretch and sharpen. Helps pale watermarks; adds noise on ordinary text."
                        />
                    }
                    checked={value.contrast}
                    onChange={(event) => set("contrast", event.currentTarget.checked)}
                />
            </SimpleGrid>
        ),
    };

    return (
        <Accordion multiple variant="separated" chevronPosition="left">
            {GROUPS.map((group) => {
                const changed = group.keys.some((key) => value[key] !== defaults[key]);

                return (
                    <Accordion.Item key={group.value} value={group.value}>
                        <Accordion.Control>
                            <Group gap="xs" wrap="nowrap">
                                <Text size="sm" fw={500}>
                                    {group.title}
                                </Text>
                                {changed && (
                                    <Tooltip label="Differs from the defaults">
                                        <Text span c="brass.4" fz={10} aria-label="changed">
                                            ●
                                        </Text>
                                    </Tooltip>
                                )}
                            </Group>
                            <Text size="xs" c="dimmed" lineClamp={1}>
                                {group.summary(value)}
                            </Text>
                        </Accordion.Control>
                        <Accordion.Panel>{fields[group.value]}</Accordion.Panel>
                    </Accordion.Item>
                );
            })}
        </Accordion>
    );
};
