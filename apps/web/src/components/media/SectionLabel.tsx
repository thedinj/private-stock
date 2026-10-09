import classes from "./SectionLabel.module.scss";

/** The label over a section of the viewer page: Frames, the facets, Note, Up next (§14b). */
export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className={classes.label}>{children}</div>
);
