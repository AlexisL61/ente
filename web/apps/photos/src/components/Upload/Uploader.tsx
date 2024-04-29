import log from "@/next/log";
import { ElectronFile, type FileAndPath } from "@/next/types/file";
import type { CollectionMapping, Electron, ZipEntry } from "@/next/types/ipc";
import { CustomError } from "@ente/shared/error";
import { isPromise } from "@ente/shared/utils";
import DiscFullIcon from "@mui/icons-material/DiscFull";
import UserNameInputDialog from "components/UserNameInputDialog";
import { UPLOAD_STAGES } from "constants/upload";
import { t } from "i18next";
import isElectron from "is-electron";
import { AppContext } from "pages/_app";
import { GalleryContext } from "pages/gallery";
import { useContext, useEffect, useRef, useState } from "react";
import billingService from "services/billingService";
import { getLatestCollections } from "services/collectionService";
import { exportMetadataDirectoryName } from "services/export";
import {
    getPublicCollectionUID,
    getPublicCollectionUploaderName,
    savePublicCollectionUploaderName,
} from "services/publicCollectionService";
import type {
    FileWithCollection,
    InProgressUpload,
    SegregatedFinishedUploads,
    UploadCounter,
    UploadFileNames,
} from "services/upload/uploadManager";
import uploadManager, {
    setToUploadCollection,
} from "services/upload/uploadManager";
import { fopFileName } from "services/upload/uploadService";
import watcher from "services/watch";
import { NotificationAttributes } from "types/Notification";
import { Collection } from "types/collection";
import {
    CollectionSelectorIntent,
    SetCollectionSelectorAttributes,
    SetCollections,
    SetFiles,
    SetLoading,
    UploadTypeSelectorIntent,
} from "types/gallery";
import { getOrCreateAlbum } from "utils/collection";
import { PublicCollectionGalleryContext } from "utils/publicCollectionGallery";
import {
    getDownloadAppMessage,
    getRootLevelFileWithFolderNotAllowMessage,
} from "utils/ui";
import { SetCollectionNamerAttributes } from "../Collections/CollectionNamer";
import { CollectionMappingChoiceModal } from "./CollectionMappingChoiceModal";
import UploadProgress from "./UploadProgress";
import UploadTypeSelector from "./UploadTypeSelector";

const FIRST_ALBUM_NAME = "My First Album";

enum PICKED_UPLOAD_TYPE {
    FILES = "files",
    FOLDERS = "folders",
    ZIPS = "zips",
}

interface Props {
    syncWithRemote: (force?: boolean, silent?: boolean) => Promise<void>;
    closeCollectionSelector?: () => void;
    closeUploadTypeSelector: () => void;
    setCollectionSelectorAttributes?: SetCollectionSelectorAttributes;
    setCollectionNamerAttributes?: SetCollectionNamerAttributes;
    setLoading: SetLoading;
    setShouldDisableDropzone: (value: boolean) => void;
    showCollectionSelector?: () => void;
    setFiles: SetFiles;
    setCollections?: SetCollections;
    isFirstUpload?: boolean;
    uploadTypeSelectorView: boolean;
    showSessionExpiredMessage: () => void;
    dragAndDropFiles: File[];
    openFileSelector: () => void;
    fileSelectorFiles: File[];
    openFolderSelector: () => void;
    folderSelectorFiles: File[];
    openZipFileSelector?: () => void;
    fileSelectorZipFiles?: File[];
    uploadCollection?: Collection;
    uploadTypeSelectorIntent: UploadTypeSelectorIntent;
    activeCollection?: Collection;
}

export default function Uploader({
    dragAndDropFiles,
    fileSelectorFiles,
    folderSelectorFiles,
    fileSelectorZipFiles,
    ...props
}: Props) {
    const appContext = useContext(AppContext);
    const galleryContext = useContext(GalleryContext);
    const publicCollectionGalleryContext = useContext(
        PublicCollectionGalleryContext,
    );

    const [uploadProgressView, setUploadProgressView] = useState(false);
    const [uploadStage, setUploadStage] = useState<UPLOAD_STAGES>(
        UPLOAD_STAGES.START,
    );
    const [uploadFileNames, setUploadFileNames] = useState<UploadFileNames>();
    const [uploadCounter, setUploadCounter] = useState<UploadCounter>({
        finished: 0,
        total: 0,
    });
    const [inProgressUploads, setInProgressUploads] = useState<
        InProgressUpload[]
    >([]);
    const [finishedUploads, setFinishedUploads] =
        useState<SegregatedFinishedUploads>(new Map());
    const [percentComplete, setPercentComplete] = useState(0);
    const [hasLivePhotos, setHasLivePhotos] = useState(false);

    const [choiceModalView, setChoiceModalView] = useState(false);
    const [userNameInputDialogView, setUserNameInputDialogView] =
        useState(false);
    const [importSuggestion, setImportSuggestion] = useState<ImportSuggestion>(
        DEFAULT_IMPORT_SUGGESTION,
    );

    /**
     * {@link File}s that the user drag-dropped or selected for uploads. This is
     * the only type of selection that is possible when we're running in the
     * browser.
     */
    const [webFiles, setWebFiles] = useState<File[]>([]);
    /**
     * {@link File}s that the user drag-dropped or selected for uploads,
     * augmented with their paths. These siblings of {@link webFiles} come into
     * play when we are running in the context of our desktop app.
     */
    const [desktopFiles, setDesktopFiles] = useState<FileAndPath[]>([]);
    /**
     * Paths of file to upload that we've received over the IPC bridge from the
     * code running in the Node.js layer of our desktop app.
     *
     * Unlike {@link filesWithPaths} which are still user initiated,
     * {@link desktopFilePaths} can be set via programmatic action. For example,
     * if the user has setup a folder watch, and a new file is added on their
     * local filesystem in one of the watched folders, then the relevant path of
     * the new file would get added to {@link desktopFilePaths}.
     */
    const [desktopFilePaths, setDesktopFilePaths] = useState<string[]>([]);
    /**
     * (zip file path, entry within zip file) tuples for zip files that the user
     * is trying to upload. These are only set when we are running in the
     * context of our desktop app. They may be set either on a user action (when
     * the user selects or drag-drops zip files) or programmatically (when the
     * app is trying to resume pending uploads from a previous session).
     */
    const [desktopZipEntries, setDesktopZipEntries] = useState<ZipEntry[]>([]);

    /**
     * Consolidated and cleaned list obtained from {@link webFiles},
     * {@link desktopFiles}, {@link desktopFilePaths} and
     * {@link desktopZipEntries}.
     */
    const itemsToUpload = useRef<(File | FileAndPath | string | ZipEntry)[]>(
        [],
    );

    /**
     * If true, then the next upload we'll be processing was initiated by our
     * desktop app.
     */
    const isPendingDesktopUpload = useRef(false);

    /**
     * If set, this will be the name of the collection that our desktop app
     * wishes for us to upload into.
     */
    const pendingDesktopUploadCollectionName = useRef<string>("");

    /**
     * This is set to thue user's choice when the user chooses one of the
     * predefined type to upload from the upload type selector dialog
     */
    const pickedUploadType = useRef<PICKED_UPLOAD_TYPE>(null);

    const currentUploadPromise = useRef<Promise<void>>(null);
    const uploadRunning = useRef(false);
    const uploaderNameRef = useRef<string>(null);
    const isDragAndDrop = useRef(false);

    const electron = globalThis.electron;

    const closeUploadProgress = () => setUploadProgressView(false);
    const showUserNameInputDialog = () => setUserNameInputDialogView(true);

    const handleChoiceModalClose = () => {
        setChoiceModalView(false);
        uploadRunning.current = false;
    };
    const handleCollectionSelectorCancel = () => {
        uploadRunning.current = false;
    };

    const handleUserNameInputDialogClose = () => {
        setUserNameInputDialogView(false);
        uploadRunning.current = false;
    };

    useEffect(() => {
        uploadManager.init(
            {
                setPercentComplete,
                setUploadCounter,
                setInProgressUploads,
                setFinishedUploads,
                setUploadStage,
                setUploadFilenames: setUploadFileNames,
                setHasLivePhotos,
                setUploadProgressView,
            },
            props.setFiles,
            publicCollectionGalleryContext,
            appContext.isCFProxyDisabled,
        );
        if (uploadManager.isUploadRunning()) {
            setUploadProgressView(true);
        }

        if (electron) {
            const upload = (collectionName: string, filePaths: string[]) => {
                isPendingDesktopUpload.current = true;
                pendingDesktopUploadCollectionName.current = collectionName;
                setDesktopFilePaths(filePaths);
            };

            const requestSyncWithRemote = () => {
                props.syncWithRemote().catch((e) => {
                    log.error(
                        "Ignoring error when syncing trash changes with remote",
                        e,
                    );
                });
            };

            watcher.init(upload, requestSyncWithRemote);

            electron.pendingUploads().then((pending) => {
                if (!pending) return;

                const { collectionName, filePaths, zipEntries } = pending;
                if (filePaths.length == 0 && zipEntries.length == 0) return;

                log.info("Resuming pending upload", pending);
                isPendingDesktopUpload.current = true;
                pendingDesktopUploadCollectionName.current = collectionName;
                setDesktopFilePaths(filePaths);
                setDesktopZipEntries(zipEntries);
            });
        }
    }, [
        publicCollectionGalleryContext.accessedThroughSharedURL,
        publicCollectionGalleryContext.token,
        publicCollectionGalleryContext.passwordToken,
        appContext.isCFProxyDisabled,
    ]);

    // Handle selected files when user selects files for upload through the open
    // file / open folder selection dialog, or drag-and-drops them.
    useEffect(() => {
        if (appContext.watchFolderView) {
            // if watch folder dialog is open don't catch the dropped file
            // as they are folder being dropped for watching
            return;
        }

        const files = [
            dragAndDropFiles,
            fileSelectorFiles,
            folderSelectorFiles,
            fileSelectorZipFiles,
        ].flat();
        if (electron) {
            desktopFilesAndZipEntries(electron, files).then(
                ({ fileAndPaths, zipEntries }) => {
                    setDesktopFiles(fileAndPaths);
                    setDesktopZipEntries(zipEntries);
                },
            );
        } else {
            setWebFiles(files);
        }
    }, [
        dragAndDropFiles,
        fileSelectorFiles,
        folderSelectorFiles,
        fileSelectorZipFiles,
    ]);

    useEffect(() => {
        if (
            webFiles.length > 0 ||
            desktopFilePaths.length > 0 ||
            electronFiles.length > 0 ||

        ) {
            log.info(
                `upload request type: ${
                    desktopFilePaths.length > 0
                        ? "desktopFilePaths"
                        : electronFiles.length > 0
                          ? "electronFiles"
                          : webFiles.length > 0
                            ? "webFiles"
                            : "-"
                } count ${
                    desktopFilePaths.length +
                    electronFiles.length +
                    webFiles.length
                }`,
            );
            if (uploadManager.isUploadRunning()) {
                if (watcher.isUploadRunning()) {
                    // Pause watch folder sync on user upload
                    log.info(
                        "Folder watcher was uploading, pausing it to first run user upload",
                    );
                    watcher.pauseRunningSync();
                } else {
                    log.info(
                        "Ignoring new upload request because an upload is already running",
                    );
                    return;
                }
            }
            uploadRunning.current = true;
            props.closeUploadTypeSelector();
            props.setLoading(true);
            if (webFiles?.length > 0) {
                // File selection by drag and drop or selection of file.
                fileOrPathsToUpload.current = webFiles;
                setWebFiles([]);
            } else if (electronFiles?.length > 0) {
                // File selection from desktop app - deprecated
                log.warn("Using deprecated code path for ElectronFiles");
                fileOrPathsToUpload.current = electronFiles.map((f) => f.path);
                setElectronFiles([]);
            } else if (desktopFilePaths && desktopFilePaths.length > 0) {
                // File selection from our desktop app
                fileOrPathsToUpload.current = desktopFilePaths;
                setDesktopFilePaths([]);
            }

            log.debug(() => "Uploader invoked");
            log.debug(() => fileOrPathsToUpload.current);

            fileOrPathsToUpload.current = pruneHiddenFiles(
                fileOrPathsToUpload.current,
            );

            if (fileOrPathsToUpload.current.length === 0) {
                props.setLoading(false);
                return;
            }

            const importSuggestion = getImportSuggestion(
                pickedUploadType.current,
                fileOrPathsToUpload.current.map((file) =>
                    /** TODO(MR): Is path valid for Web files? */
                    typeof file == "string" ? file : file["path"],
                ),
            );
            setImportSuggestion(importSuggestion);

            log.debug(() => importSuggestion);

            handleCollectionCreationAndUpload(
                importSuggestion,
                props.isFirstUpload,
                pickedUploadType.current,
                publicCollectionGalleryContext.accessedThroughSharedURL,
            );
            pickedUploadType.current = null;
            props.setLoading(false);
        }
    }, [webFiles, , electronFiles, desktopFilePaths]);

    const preCollectionCreationAction = async () => {
        props.closeCollectionSelector?.();
        props.setShouldDisableDropzone(!uploadManager.shouldAllowNewUpload());
        setUploadStage(UPLOAD_STAGES.START);
        setUploadProgressView(true);
    };

    const uploadFilesToExistingCollection = async (
        collection: Collection,
        uploaderName?: string,
    ) => {
        try {
            log.info(
                `Uploading files existing collection id ${collection.id} (${collection.name})`,
            );
            await preCollectionCreationAction();
            const filesWithCollectionToUpload = fileOrPathsToUpload.current.map(
                (fileOrPath, index) => ({
                    fileOrPath,
                    localID: index,
                    collectionID: collection.id,
                }),
            );
            await waitInQueueAndUploadFiles(
                filesWithCollectionToUpload,
                [collection],
                uploaderName,
            );
        } catch (e) {
            log.error("Failed to upload files to existing collection", e);
        }
    };

    const uploadFilesToNewCollections = async (
        mapping: CollectionMapping,
        collectionName?: string,
    ) => {
        try {
            log.info(
                `Uploading files to collection using ${mapping} mapping (${collectionName ?? "<NA>"})`,
            );
            await preCollectionCreationAction();
            let filesWithCollectionToUpload: FileWithCollection[] = [];
            const collections: Collection[] = [];
            let collectionNameToFileOrPaths = new Map<
                string,
                (File | string)[]
            >();
            if (mapping == "root") {
                collectionNameToFileOrPaths.set(
                    collectionName,
                    fileOrPathsToUpload.current,
                );
            } else {
                collectionNameToFileOrPaths = groupFilesBasedOnParentFolder(
                    fileOrPathsToUpload.current,
                );
            }
            try {
                const existingCollections = await getLatestCollections();
                let index = 0;
                for (const [
                    collectionName,
                    fileOrPaths,
                ] of collectionNameToFileOrPaths) {
                    const collection = await getOrCreateAlbum(
                        collectionName,
                        existingCollections,
                    );
                    collections.push(collection);
                    props.setCollections([
                        ...existingCollections,
                        ...collections,
                    ]);
                    filesWithCollectionToUpload = [
                        ...filesWithCollectionToUpload,
                        ...fileOrPaths.map((fileOrPath) => ({
                            localID: index++,
                            collectionID: collection.id,
                            fileOrPath,
                        })),
                    ];
                }
            } catch (e) {
                closeUploadProgress();
                log.error("Failed to create album", e);
                appContext.setDialogMessage({
                    title: t("ERROR"),
                    close: { variant: "critical" },
                    content: t("CREATE_ALBUM_FAILED"),
                });
                throw e;
            }
            await waitInQueueAndUploadFiles(
                filesWithCollectionToUpload,
                collections,
            );
            fileOrPathsToUpload.current = null;
        } catch (e) {
            log.error("Failed to upload files to new collections", e);
        }
    };

    const waitInQueueAndUploadFiles = async (
        filesWithCollectionToUploadIn: FileWithCollection[],
        collections: Collection[],
        uploaderName?: string,
    ) => {
        const currentPromise = currentUploadPromise.current;
        currentUploadPromise.current = waitAndRun(
            currentPromise,
            async () =>
                await uploadFiles(
                    filesWithCollectionToUploadIn,
                    collections,
                    uploaderName,
                ),
        );
        await currentUploadPromise.current;
    };

    const preUploadAction = async () => {
        uploadManager.prepareForNewUpload();
        setUploadProgressView(true);
        await props.syncWithRemote(true, true);
    };

    function postUploadAction() {
        props.setShouldDisableDropzone(false);
        uploadRunning.current = false;
        props.syncWithRemote();
    }

    const uploadFiles = async (
        filesWithCollectionToUploadIn: FileWithCollection[],
        collections: Collection[],
        uploaderName?: string,
    ) => {
        try {
            preUploadAction();
            if (
                electron &&
                !isPendingDesktopUpload.current &&
                !watcher.isUploadRunning()
            ) {
                await setToUploadCollection(collections);
                if (zipPaths.current) {
                    await electron.setPendingUploadFiles(
                        "zips",
                        zipPaths.current,
                    );
                    zipPaths.current = null;
                }
                await electron.setPendingUploadFiles(
                    "files",
                    filesWithCollectionToUploadIn.map(
                        // TODO(MR): ElectronFile
                        ({ fileOrPath }) =>
                            typeof fileOrPath == "string"
                                ? fileOrPath
                                : (fileOrPath as any as ElectronFile).path,
                    ),
                );
            }
            const wereFilesProcessed = await uploadManager.uploadFiles(
                filesWithCollectionToUploadIn,
                collections,
                uploaderName,
            );
            if (!wereFilesProcessed) closeUploadProgress();
            if (isElectron()) {
                if (watcher.isUploadRunning()) {
                    await watcher.allFileUploadsDone(
                        filesWithCollectionToUploadIn,
                        collections,
                    );
                } else if (watcher.isSyncPaused()) {
                    // resume the service after user upload is done
                    watcher.resumePausedSync();
                }
            }
        } catch (e) {
            log.error("Failed to upload files", e);
            showUserFacingError(e.message);
            closeUploadProgress();
        } finally {
            postUploadAction();
        }
    };

    const retryFailed = async () => {
        try {
            log.info("Retrying failed uploads");
            const { files, collections } =
                uploadManager.getFailedFilesWithCollections();
            const uploaderName = uploadManager.getUploaderName();
            await preUploadAction();
            await uploadManager.uploadFiles(files, collections, uploaderName);
        } catch (e) {
            log.error("Retrying failed uploads failed", e);
            showUserFacingError(e.message);
            closeUploadProgress();
        } finally {
            postUploadAction();
        }
    };

    function showUserFacingError(err: string) {
        let notification: NotificationAttributes;
        switch (err) {
            case CustomError.SESSION_EXPIRED:
                return props.showSessionExpiredMessage();
            case CustomError.SUBSCRIPTION_EXPIRED:
                notification = {
                    variant: "critical",
                    subtext: t("SUBSCRIPTION_EXPIRED"),
                    message: t("RENEW_NOW"),
                    onClick: () => billingService.redirectToCustomerPortal(),
                };
                break;
            case CustomError.STORAGE_QUOTA_EXCEEDED:
                notification = {
                    variant: "critical",
                    subtext: t("STORAGE_QUOTA_EXCEEDED"),
                    message: t("UPGRADE_NOW"),
                    onClick: () => galleryContext.showPlanSelectorModal(),
                    startIcon: <DiscFullIcon />,
                };
                break;
            default:
                notification = {
                    variant: "critical",
                    message: t("UNKNOWN_ERROR"),
                    onClick: () => null,
                };
        }
        appContext.setNotificationAttributes(notification);
    }

    const uploadToSingleNewCollection = (collectionName: string) => {
        uploadFilesToNewCollections("root", collectionName);
    };

    const showCollectionCreateModal = (suggestedName: string) => {
        props.setCollectionNamerAttributes({
            title: t("CREATE_COLLECTION"),
            buttonText: t("CREATE"),
            autoFilledName: suggestedName,
            callback: uploadToSingleNewCollection,
        });
    };

    const handleCollectionCreationAndUpload = async (
        importSuggestion: ImportSuggestion,
        isFirstUpload: boolean,
        pickedUploadType: PICKED_UPLOAD_TYPE,
        accessedThroughSharedURL?: boolean,
    ) => {
        try {
            if (accessedThroughSharedURL) {
                const uploaderName = await getPublicCollectionUploaderName(
                    getPublicCollectionUID(
                        publicCollectionGalleryContext.token,
                    ),
                );
                uploaderNameRef.current = uploaderName;
                showUserNameInputDialog();
                return;
            }

            if (isPendingDesktopUpload.current) {
                isPendingDesktopUpload.current = false;
                if (pendingDesktopUploadCollectionName.current) {
                    uploadFilesToNewCollections(
                        "root",
                        pendingDesktopUploadCollectionName.current,
                    );
                    pendingDesktopUploadCollectionName.current = null;
                } else {
                    uploadFilesToNewCollections("parent");
                }
                return;
            }

            if (isElectron() && pickedUploadType === PICKED_UPLOAD_TYPE.ZIPS) {
                uploadFilesToNewCollections("parent");
                return;
            }

            if (isFirstUpload && !importSuggestion.rootFolderName) {
                importSuggestion.rootFolderName = FIRST_ALBUM_NAME;
            }

            if (isDragAndDrop.current) {
                isDragAndDrop.current = false;
                if (
                    props.activeCollection &&
                    props.activeCollection.owner.id === galleryContext.user?.id
                ) {
                    uploadFilesToExistingCollection(props.activeCollection);
                    return;
                }
            }

            let showNextModal = () => {};
            if (importSuggestion.hasNestedFolders) {
                showNextModal = () => setChoiceModalView(true);
            } else {
                showNextModal = () =>
                    showCollectionCreateModal(importSuggestion.rootFolderName);
            }

            props.setCollectionSelectorAttributes({
                callback: uploadFilesToExistingCollection,
                onCancel: handleCollectionSelectorCancel,
                showNextModal,
                intent: CollectionSelectorIntent.upload,
            });
        } catch (e) {
            // TODO(MR): Why?
            log.warn("Ignoring error in handleCollectionCreationAndUpload", e);
        }
    };

    const cancelUploads = () => {
        uploadManager.cancelRunningUpload();
    };

    const handleUpload = async (type: PICKED_UPLOAD_TYPE) => {
        pickedUploadType.current = type;
        if (type === PICKED_UPLOAD_TYPE.FILES) {
            props.showUploadFilesDialog();
        } else if (type === PICKED_UPLOAD_TYPE.FOLDERS) {
            props.showUploadDirsDialog();
        } else {
            if (props.showUploadZipFilesDialog && electron) {
                props.showUploadZipFilesDialog();
            } else {
                appContext.setDialogMessage(getDownloadAppMessage());
            }
        }
    };

    const handleFileUpload = handleUpload(PICKED_UPLOAD_TYPE.FILES);
    const handleFolderUpload = handleUpload(PICKED_UPLOAD_TYPE.FOLDERS);
    const handleZipUpload = handleUpload(PICKED_UPLOAD_TYPE.ZIPS);

    const handlePublicUpload = async (
        uploaderName: string,
        skipSave?: boolean,
    ) => {
        try {
            if (!skipSave) {
                savePublicCollectionUploaderName(
                    getPublicCollectionUID(
                        publicCollectionGalleryContext.token,
                    ),
                    uploaderName,
                );
            }
            await uploadFilesToExistingCollection(
                props.uploadCollection,
                uploaderName,
            );
        } catch (e) {
            log.error("public upload failed ", e);
        }
    };

    const handleUploadToSingleCollection = () => {
        uploadToSingleNewCollection(importSuggestion.rootFolderName);
    };

    const handleUploadToMultipleCollections = () => {
        if (importSuggestion.hasRootLevelFileWithFolder) {
            appContext.setDialogMessage(
                getRootLevelFileWithFolderNotAllowMessage(),
            );
            return;
        }
        uploadFilesToNewCollections("parent");
    };

    const didSelectCollectionMapping = (mapping: CollectionMapping) => {
        switch (mapping) {
            case "root":
                handleUploadToSingleCollection();
                break;
            case "parent":
                handleUploadToMultipleCollections();
                break;
        }
    };

    return (
        <>
            <CollectionMappingChoiceModal
                open={choiceModalView}
                onClose={handleChoiceModalClose}
                didSelect={didSelectCollectionMapping}
            />
            <UploadTypeSelector
                show={props.uploadTypeSelectorView}
                onClose={props.closeUploadTypeSelector}
                uploadFiles={handleFileUpload}
                uploadFolders={handleFolderUpload}
                uploadGoogleTakeoutZips={handleZipUpload}
                uploadTypeSelectorIntent={props.uploadTypeSelectorIntent}
            />
            <UploadProgress
                open={uploadProgressView}
                onClose={closeUploadProgress}
                percentComplete={percentComplete}
                uploadFileNames={uploadFileNames}
                uploadCounter={uploadCounter}
                uploadStage={uploadStage}
                inProgressUploads={inProgressUploads}
                hasLivePhotos={hasLivePhotos}
                retryFailed={retryFailed}
                finishedUploads={finishedUploads}
                cancelUploads={cancelUploads}
            />
            <UserNameInputDialog
                open={userNameInputDialogView}
                onClose={handleUserNameInputDialogClose}
                onNameSubmit={handlePublicUpload}
                toUploadFilesCount={fileOrPathsToUpload.current?.length}
                uploaderName={uploaderNameRef.current}
            />
        </>
    );
}

async function waitAndRun(
    waitPromise: Promise<void>,
    task: () => Promise<void>,
) {
    if (waitPromise && isPromise(waitPromise)) {
        await waitPromise;
    }
    await task();
}

const desktopFilesAndZipEntries = async (
    electron: Electron,
    files: File[],
): Promise<{ fileAndPaths: FileAndPath[]; zipEntries: ZipEntry[] }> => {
    const fileAndPaths: FileAndPath[] = [];
    const zipEntries: ZipEntry[] = [];

    for (const file of files) {
        const path = electron.pathForFile(file);
        if (file.name.endsWith(".zip")) {
            zipEntries = zipEntries.concat(await electron.listZipEntries(path));
        } else {
            fileAndPaths.push({ file, path });
        }
    }

    return { fileAndPaths, zipEntries };
};

// This is used to prompt the user the make upload strategy choice
interface ImportSuggestion {
    rootFolderName: string;
    hasNestedFolders: boolean;
    hasRootLevelFileWithFolder: boolean;
}

const DEFAULT_IMPORT_SUGGESTION: ImportSuggestion = {
    rootFolderName: "",
    hasNestedFolders: false,
    hasRootLevelFileWithFolder: false,
};

function getImportSuggestion(
    uploadType: PICKED_UPLOAD_TYPE,
    paths: string[],
): ImportSuggestion {
    if (isElectron() && uploadType === PICKED_UPLOAD_TYPE.FILES) {
        return DEFAULT_IMPORT_SUGGESTION;
    }

    const getCharCount = (str: string) => (str.match(/\//g) ?? []).length;
    paths.sort((path1, path2) => getCharCount(path1) - getCharCount(path2));
    const firstPath = paths[0];
    const lastPath = paths[paths.length - 1];

    const L = firstPath.length;
    let i = 0;
    const firstFileFolder = firstPath.substring(0, firstPath.lastIndexOf("/"));
    const lastFileFolder = lastPath.substring(0, lastPath.lastIndexOf("/"));

    while (i < L && firstPath.charAt(i) === lastPath.charAt(i)) i++;
    let commonPathPrefix = firstPath.substring(0, i);

    if (commonPathPrefix) {
        commonPathPrefix = commonPathPrefix.substring(
            0,
            commonPathPrefix.lastIndexOf("/"),
        );
        if (commonPathPrefix) {
            commonPathPrefix = commonPathPrefix.substring(
                commonPathPrefix.lastIndexOf("/") + 1,
            );
        }
    }
    return {
        rootFolderName: commonPathPrefix || null,
        hasNestedFolders: firstFileFolder !== lastFileFolder,
        hasRootLevelFileWithFolder: firstFileFolder === "",
    };
}

// This function groups files that are that have the same parent folder into collections
// For Example, for user files have a directory structure like this
//              a
//            / |  \
//           b  j   c
//          /|\    /  \
//         e f g   h  i
//
// The files will grouped into 3 collections.
// [a => [j],
// b => [e,f,g],
// c => [h, i]]
const groupFilesBasedOnParentFolder = (fileOrPaths: (File | string)[]) => {
    const result = new Map<string, (File | string)[]>();
    for (const fileOrPath of fileOrPaths) {
        const filePath =
            /* TODO(MR): ElectronFile */
            typeof fileOrPath == "string"
                ? fileOrPath
                : (fileOrPath["path"] as string);

        let folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
        // If the parent folder of a file is "metadata"
        // we consider it to be part of the parent folder
        // For Eg,For FileList  -> [a/x.png, a/metadata/x.png.json]
        // they will both we grouped into the collection "a"
        // This is cluster the metadata json files in the same collection as the file it is for
        if (folderPath.endsWith(exportMetadataDirectoryName)) {
            folderPath = folderPath.substring(0, folderPath.lastIndexOf("/"));
        }
        const folderName = folderPath.substring(
            folderPath.lastIndexOf("/") + 1,
        );
        if (!folderName) throw Error("Unexpected empty folder name");
        if (!result.has(folderName)) result.set(folderName, []);
        result.get(folderName).push(fileOrPath);
    }
    return result;
};

/**
 * Filter out hidden files from amongst {@link fileOrPaths}.
 *
 * Hidden files are those whose names begin with a "." (dot).
 */
const pruneHiddenFiles = (fileOrPaths: (File | string)[]) =>
    fileOrPaths.filter((f) => !fopFileName(f).startsWith("."));
