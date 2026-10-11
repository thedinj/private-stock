export * as userRepo from "./userRepo.js";
export * as invitationRepo from "./invitationRepo.js";
export * as refreshTokenRepo from "./refreshTokenRepo.js";
export * as errorLogRepo from "./errorLogRepo.js";
export * as mediaRootRepo from "./mediaRootRepo.js";
export * as mediaFileRepo from "./mediaFileRepo.js";
export * as mediaRepo from "./mediaRepo.js";
export * as artifactRepo from "./artifactRepo.js";
export * as variantRepo from "./variantRepo.js";
export * as changeLogRepo from "./changeLogRepo.js";
export * as settingRepo from "./settingRepo.js";
export * as scanRepo from "./scanRepo.js";
export * as userMediaRepo from "./userMediaRepo.js";
export * as userTagRepo from "./userTagRepo.js";
export * as tagRepo from "./tagRepo.js";
export * as tagPictureRepo from "./tagPictureRepo.js";
export * as faceRepo from "./faceRepo.js";
export * as faceAutoTagRepo from "./faceAutoTagRepo.js";
export * as faceDecisionRepo from "./faceDecisionRepo.js";
export * as appearanceRepo from "./appearanceRepo.js";
export * as mentionRepo from "./mentionRepo.js";
export * as searchRepo from "./searchRepo.js";
export * as mediaTextRepo from "./mediaTextRepo.js";
export * as mediaAttributeRepo from "./mediaAttributeRepo.js";
export * as ocrTrialRepo from "./ocrTrialRepo.js";
export * as ocrTuneRepo from "./ocrTuneRepo.js";
export * as phashRepo from "./phashRepo.js";
export * as dupeRepo from "./dupeRepo.js";
export * as stageRepo from "./stageRepo.js";
export * as trashRepo from "./trashRepo.js";
export * as jobRepo from "./jobRepo.js";
export * as clipRepo from "./clipRepo.js";
export * as clipTagRepo from "./clipTagRepo.js";
export * as playlistRepo from "./playlistRepo.js";
export * as reelRepo from "./reelRepo.js";
export * as savedFilterRepo from "./savedFilterRepo.js";
export * as collectionPinRepo from "./collectionPinRepo.js";
export * as homeLayoutRepo from "./homeLayoutRepo.js";
export * as userPrefRepo from "./userPrefRepo.js";
export * as tagBatchRepo from "./tagBatchRepo.js";
export * as ocrTagMatchRepo from "./ocrTagMatchRepo.js";

/**
 * Row and input types, re-exported at the top level.
 *
 * The repos themselves are namespaced (`mediaRepo.listMedia`) so call sites read clearly,
 * but a namespace export does not surface its types — consumers would otherwise have to
 * reach into the module path to name a row.
 */
export type { UserRow, UserListRow, CreateUserInput } from "./userRepo.js";
export type { InvitationRow, InvitationListRow, NewInvitationInput } from "./invitationRepo.js";
export type { RefreshTokenRow, IssuedToken } from "./refreshTokenRepo.js";
export type { ErrorLogRow, LogErrorInput } from "./errorLogRepo.js";
export type { MediaRootRow } from "./mediaRootRepo.js";
export type { MediaFileRow, UpsertFileInput, UpsertResult } from "./mediaFileRepo.js";
export type {
    MediaListRow,
    MediaDetailRow,
    ListResult,
    ProbeResult,
    CreateMediaInput,
    MediaBasicRow,
    TranscodeCandidateRow,
} from "./mediaRepo.js";
export type { ScanRow, ScanCounts } from "./scanRepo.js";
export type {
    ArtifactRow,
    ArtifactKind,
    ArtifactSource,
    UpsertArtifactInput,
    MissingArtifactRow,
} from "./artifactRepo.js";
export type { ChangeRow, ChangeEntity, ChangeOp, RecordChangeInput } from "./changeLogRepo.js";
export type { VariantRow, UpsertVariantInput } from "./variantRepo.js";
export type { TagRow, TagWithCountRow, MediaTagRow, AssignInput } from "./tagRepo.js";
export type { SearchDocument } from "./searchRepo.js";
export type { FacetCountRow, FacetScope } from "./mediaRepo.js";
export type { PhashRow, VideoFrameRow, VideoFrameInput } from "./phashRepo.js";
export type { DupeKind, DupeGroupRow, DupeMemberRow, DupeGroupSummary } from "./dupeRepo.js";
export type { RecordStageInput, PendingItem, StageSummaryRow } from "./stageRepo.js";
export type { QueueSummary, QueueKindRow } from "./jobRepo.js";
export type { TrashEntryRow, TrashListRow, CreateTrashEntryInput } from "./trashRepo.js";
export type { PlaylistRow, PlaylistSummaryRow, NewPlaylistInput } from "./playlistRepo.js";
export type { ClipRow, ClipSummaryRow, NewClipInput } from "./clipRepo.js";
export type { ClipTagRow, ClipTagFacetRow } from "./clipTagRepo.js";
export type { ReelRow, ReelSummaryRow, ReelEntryRow, NewReelInput } from "./reelRepo.js";
export type { OverlayRow } from "./userMediaRepo.js";
export type { SavedFilterRow, NewSavedFilterInput } from "./savedFilterRepo.js";
export type { CollectionPinRow } from "./collectionPinRepo.js";
export type {
    TagBatchRow,
    ApplyBatchInput,
    ApplyBatchResult,
    ApplyClipBatchInput,
} from "./tagBatchRepo.js";
export type { DecisionRow, DecisionSurface, NewDecision } from "./faceDecisionRepo.js";
export type {
    AppearanceSourceFace,
    ItemPersonRow,
    NewAppearance,
    SuggestionRow,
    SuggestLines,
} from "./appearanceRepo.js";
