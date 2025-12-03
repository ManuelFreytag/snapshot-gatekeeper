
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ImageFile, ProcessStatus } from './types';
import { evaluateImage, evaluateImageGroup } from './services/geminiService';
import { parseXMP, saveXMPInDirectory, verifyPermission, deleteFile, moveFileToSubfolder, generateXMPContent } from './services/fileSystem';
import { saveRecentFolder, getRecentFolders, RecentFolder } from './services/storage';
import { resizeImage, getDateTaken } from './services/imageProcessing';
import ImageThumbnail from './components/ImageThumbnail';
import InspectorPanel from './components/InspectorPanel';
import { FolderOpen, AlertCircle, Play, Pause, RefreshCw, AlertTriangle, History, Filter, Trash2 } from 'lucide-react';

type FilterType = 'all' | 'keep' | 'reject';

const App: React.FC = () => {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<ImageFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [isProcessing, setIsProcessing] = useState(true); 
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [readOnlyMode, setReadOnlyMode] = useState(false);
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>([]);
  
  const [filter, setFilter] = useState<FilterType>('all');
  const [isArchiving, setIsArchiving] = useState(false);
  
  const filesRef = useRef<ImageFile[]>([]);
  const isProcessingRef = useRef(isProcessing);
  const processingRef = useRef(false);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    getRecentFolders().then(setRecentFolders);
  }, []);

  // Main Processing Loop with Burst Detection
  useEffect(() => {
    const processQueue = async () => {
      if (processingRef.current || !isProcessingRef.current) return;

      const currentFiles = filesRef.current;
      const nextFileIndex = currentFiles.findIndex(f => f.status === 'pending');
      if (nextFileIndex === -1) return;

      processingRef.current = true;
      
      // --- BURST DETECTION START ---
      const batchCandidates: { index: number, file: ImageFile, fileObj: File, timestamp: number }[] = [];
      
      try {
        // Get the first file
        const firstFileObj = await currentFiles[nextFileIndex].handle.getFile();
        const firstTimestamp = await getDateTaken(firstFileObj);

        batchCandidates.push({ 
            index: nextFileIndex, 
            file: currentFiles[nextFileIndex], 
            fileObj: firstFileObj,
            timestamp: firstTimestamp
        });

        // Look ahead for similar files
        let lookAhead = 1;
        const MAX_BATCH_SIZE = 4; // Gemini payload limit safety

        while (
            batchCandidates.length < MAX_BATCH_SIZE && 
            (nextFileIndex + lookAhead) < currentFiles.length
        ) {
            const candidateIndex = nextFileIndex + lookAhead;
            const candidateFile = currentFiles[candidateIndex];
            
            // Only group if pending
            if (candidateFile.status !== 'pending') break;

            const candidateFileObj = await candidateFile.handle.getFile();
            const candidateTimestamp = await getDateTaken(candidateFileObj);
            
            const prevTimestamp = batchCandidates[batchCandidates.length - 1].timestamp;
            const startTimestamp = batchCandidates[0].timestamp;

            // Calculate Deltas
            const neighborDelta = Math.abs(candidateTimestamp - prevTimestamp);
            const totalDelta = Math.abs(candidateTimestamp - startTimestamp);
            
            // Burst Criteria:
            // 1. Neighboring images must be close (< 2s)
            // 2. Total sequence shouldn't drift too long (< 4s from start)
            // 3. We allow delta === 0 because high-speed bursts often have identical second timestamps in EXIF
            if (neighborDelta < 2000 && totalDelta < 4000) {
                batchCandidates.push({
                    index: candidateIndex,
                    file: candidateFile,
                    fileObj: candidateFileObj,
                    timestamp: candidateTimestamp
                });
            } else {
                break;
            }
            lookAhead++;
        }
      } catch (e) {
          console.error("Error checking file timestamps", e);
      }
      // --- BURST DETECTION END ---

      // Mark batch as processing
      const processingIds = new Set(batchCandidates.map(c => c.file.id));
      setFiles(prev => prev.map(f => 
        processingIds.has(f.id) ? { ...f, status: 'processing' } : f
      ));

      try {
        if (batchCandidates.length > 1) {
            // --- GROUP PROCESSING ---
            console.log(`Processing burst group of ${batchCandidates.length} images`);
            
            // 1. Resize and Prepare
            const preparedImages = await Promise.all(batchCandidates.map(async (c) => {
                const resized = await resizeImage(c.fileObj);
                return {
                    name: c.file.name,
                    base64: resized.base64,
                    mimeType: resized.mimeType
                };
            }));

            // 2. Evaluate Group
            const groupResults = await evaluateImageGroup(preparedImages);

            // 3. Save and Update
            const updates = batchCandidates.map(async (c) => {
                const result = groupResults[c.file.name];
                
                if (!result) {
                    throw new Error(`No result for ${c.file.name} in group response`);
                }

                let xmpHandle = undefined;
                if (dirHandle) {
                    try {
                        xmpHandle = await saveXMPInDirectory(dirHandle, c.file.name, generateXMPContent(result));
                    } catch (e) { console.warn("Auto-save XMP failed", e); }
                }

                return {
                    id: c.file.id,
                    evaluation: result,
                    status: 'done' as ProcessStatus,
                    xmpHandle
                };
            });
            
            const resolvedUpdates = await Promise.all(updates);

            // Bulk update state
            setFiles(prev => {
                const next = [...prev];
                resolvedUpdates.forEach(u => {
                    const idx = next.findIndex(f => f.id === u.id);
                    if (idx !== -1) {
                        next[idx] = { ...next[idx], ...u };
                    }
                });
                return next;
            });

        } else {
            // --- SINGLE PROCESSING ---
            const target = batchCandidates[0];
            const resized = await resizeImage(target.fileObj);
            const evaluation = await evaluateImage(resized.base64, resized.mimeType);

            let xmpHandle;
            if (dirHandle) {
                try {
                    xmpHandle = await saveXMPInDirectory(dirHandle, target.file.name, generateXMPContent(evaluation));
                } catch (e) { console.warn("Auto-save XMP failed", e); }
            }

            setFiles(prev => prev.map(f => 
                f.id === target.file.id 
                ? { ...f, status: 'done', evaluation, xmpHandle } 
                : f
            ));
        }
      } catch (error: any) {
        console.error(`Error processing batch:`, error);
        setFiles(prev => prev.map(f => 
            processingIds.has(f.id)
              ? { ...f, status: 'error', errorMessage: error.message } 
              : f
          ));
      } finally {
        processingRef.current = false;
        setTimeout(processQueue, 500); 
      }
    };

    const interval = setInterval(processQueue, 1000); 
    return () => clearInterval(interval);
  }, [dirHandle]);

  const processDirectory = async (handle: FileSystemDirectoryHandle) => {
    setDirHandle(handle);
    setReadOnlyMode(false);
    setLoadingFiles(true);
    setFiles([]);
    setSelectedFileId(null);
    setFilter('all');
    saveRecentFolder(handle).then(() => getRecentFolders().then(setRecentFolders));

    const imageFiles: ImageFile[] = [];
    const xmpHandles = new Map<string, FileSystemFileHandle>();

    try {
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
          const name = entry.name.toLowerCase();
          if (name.endsWith('.xmp')) {
            const baseName = entry.name.substring(0, entry.name.lastIndexOf('.'));
            xmpHandles.set(baseName.toLowerCase(), entry as FileSystemFileHandle);
          }
        }
      }

      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
            const name = entry.name.toLowerCase();
            if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp')) {
                const baseName = entry.name.substring(0, entry.name.lastIndexOf('.'));
                const xmpHandle = xmpHandles.get(baseName.toLowerCase());
                
                let evaluation = undefined;
                let status: ProcessStatus = 'pending';

                if (xmpHandle) {
                    const parsed = await parseXMP(xmpHandle);
                    if (parsed) {
                        evaluation = parsed;
                        status = 'done';
                    }
                }

                imageFiles.push({
                    id: entry.name,
                    handle: entry as FileSystemFileHandle,
                    name: entry.name,
                    type: 'image',
                    status,
                    evaluation,
                    xmpHandle
                });
            }
        }
      }

      setFiles(imageFiles.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      console.error("Error processing directory:", err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      if (!('showDirectoryPicker' in window)) {
        throw new Error("API unsupported");
      }

      const handle = await (window as any).showDirectoryPicker();
      await verifyPermission(handle, true);
      await processDirectory(handle);

    } catch (err: any) {
      if (err.name === 'AbortError') return;
      console.warn("File System Access API failed or cancelled.", err);
      if (err.name !== 'AbortError') {
        fileInputRef.current?.click();
      }
    }
  };

  const handleRecentFolderClick = async (folder: RecentFolder) => {
    try {
      const hasPermission = await verifyPermission(folder.handle, true);
      if (hasPermission) {
        await processDirectory(folder.handle);
      } else {
        alert("Permission denied to access this folder. Please open it again.");
      }
    } catch (e) {
      console.error("Failed to re-open recent folder:", e);
      alert("Could not access folder. It may have been moved or deleted.");
    }
  };

  const handleFallbackSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;

    setLoadingFiles(true);
    setDirHandle(null);
    setReadOnlyMode(true);
    setFiles([]);
    setSelectedFileId(null);
    setIsProcessing(true); 

    const rawFiles: File[] = Array.from(fileList);
    const newFiles: ImageFile[] = [];
    const xmpMap = new Map<string, File>();

    rawFiles.forEach(file => {
        if (file.name.toLowerCase().endsWith('.xmp')) {
            const baseName = file.name.substring(0, file.name.lastIndexOf('.'));
            xmpMap.set(baseName.toLowerCase(), file);
        }
    });

    for (const file of rawFiles) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp')) {
            
            const baseName = file.name.substring(0, file.name.lastIndexOf('.'));
            const xmpFile = xmpMap.get(baseName.toLowerCase());
            
            let evaluation = undefined;
            let status: ProcessStatus = 'pending';
            let xmpHandle;

            if (xmpFile) {
                const mockXmpHandle = {
                    kind: 'file',
                    name: xmpFile.name,
                    getFile: async () => xmpFile,
                    isSameEntry: async () => false,
                } as unknown as FileSystemFileHandle;
                
                const parsed = await parseXMP(mockXmpHandle);
                if (parsed) {
                    evaluation = parsed;
                    status = 'done';
                    xmpHandle = mockXmpHandle;
                }
            }

            newFiles.push({
                id: (file as any).webkitRelativePath || file.name,
                handle: {
                    kind: 'file',
                    name: file.name,
                    getFile: async () => file,
                    isSameEntry: async () => false,
                } as unknown as FileSystemFileHandle,
                name: file.name,
                type: file.type || 'image/jpeg',
                status,
                evaluation,
                xmpHandle
            });
        }
    }

    setFiles(newFiles.sort((a, b) => a.name.localeCompare(b.name)));
    setLoadingFiles(false);
  };

  const handleUpdateFile = useCallback((updatedFile: ImageFile) => {
    setFiles(prev => prev.map(f => f.id === updatedFile.id ? updatedFile : f));
  }, []);

  const handleDeleteFile = useCallback(async (fileToDelete: ImageFile) => {
    if (!dirHandle) return;
    try {
        await deleteFile(dirHandle, fileToDelete.name, fileToDelete.xmpHandle);
        setFiles(prev => prev.filter(f => f.id !== fileToDelete.id));
        setSelectedFileId(null);
    } catch (e) {
        console.error("Delete failed", e);
        throw e;
    }
  }, [dirHandle]);

  const handleArchiveRejects = async () => {
    if (!dirHandle) return;
    if (!confirm("This will move all discarded/rejected images to a '_Rejected' subfolder. Continue?")) return;

    setIsArchiving(true);
    setIsProcessing(false); 

    const rejects = files.filter(f => f.evaluation && !f.evaluation.isWorthKeeping);
    const updatedFiles = [...files];

    try {
        for (const file of rejects) {
            await moveFileToSubfolder(dirHandle, file.handle, '_Rejected', file.xmpHandle);
            const idx = updatedFiles.findIndex(f => f.id === file.id);
            if (idx !== -1) updatedFiles.splice(idx, 1);
        }
        setFiles(updatedFiles);
        setFilter('all'); 
        setSelectedFileId(null);
    } catch (e) {
        console.error("Archive failed", e);
        alert("Failed to move some files. Check console for details.");
    } finally {
        setIsArchiving(false);
    }
  };

  const handleThumbnailClick = useCallback((id: string) => {
    setSelectedFileId(id);
  }, []);

  const selectedFile = files.find(f => f.id === selectedFileId) || null;
  const pendingCount = files.filter(f => f.status === 'pending').length;
  const processingCount = files.filter(f => f.status === 'processing').length;

  const filteredFiles = files.filter(f => {
      if (filter === 'all') return true;
      if (filter === 'keep') return f.evaluation?.isWorthKeeping === true;
      if (filter === 'reject') return f.evaluation?.isWorthKeeping === false;
      return true;
  });

  return (
    <div className="flex h-screen w-full flex-col bg-gray-950 text-gray-100 font-sans">
        <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFallbackSelect} 
            className="hidden" 
            {...({webkitdirectory: "", directory: "", multiple: true} as any)} 
        />

      <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-950/80 px-6 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 shadow-lg shadow-indigo-500/30">
             <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
             </svg>
          </div>
          <span className="text-xl font-bold tracking-tight">LensGrade AI</span>
        </div>
        
        <div className="flex items-center gap-4">
          {files.length > 0 && (
              <div className="flex items-center gap-2 mr-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">
                    {pendingCount > 0 ? `${pendingCount} Pending` : 'All Done'}
                  </span>
                  <button 
                    onClick={() => setIsProcessing(!isProcessing)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition ${isProcessing ? 'bg-indigo-900/30 border-indigo-500/50 text-indigo-200' : 'bg-gray-800 border-gray-700 text-gray-400'}`}
                  >
                    {isProcessing ? <Pause size={12} fill="currentColor"/> : <Play size={12} fill="currentColor"/>}
                    {isProcessing ? 'Auto-Processing' : 'Paused'}
                  </button>
                  {(processingCount > 0 || isArchiving) && <RefreshCw size={14} className="animate-spin text-indigo-500"/>}
              </div>
          )}

          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-medium transition hover:border-indigo-500 hover:text-indigo-400 active:bg-gray-800"
          >
            <FolderOpen size={16} />
            {files.length > 0 ? 'Change Folder' : 'Open Folder'}
          </button>
        </div>
      </div>

      {readOnlyMode && files.length > 0 && (
          <div className="flex items-center justify-center gap-2 bg-yellow-500/10 border-b border-yellow-500/20 py-2 px-4 text-xs text-yellow-500">
             <AlertTriangle size={14} />
             <span>
               <strong>Read-Only Mode:</strong> Automatic XMP saving is disabled.
             </span>
          </div>
      )}

      {files.length > 0 && (
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900/50">
             <div className="flex gap-1">
                 <button 
                    onClick={() => setFilter('all')}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${filter === 'all' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:bg-gray-800'}`}
                 >
                    All Files <span className="ml-1 opacity-60 text-xs">{files.length}</span>
                 </button>
                 <button 
                    onClick={() => setFilter('keep')}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${filter === 'keep' ? 'bg-green-600 text-white shadow-md' : 'text-gray-400 hover:bg-gray-800'}`}
                 >
                    Worth Keeping <span className="ml-1 opacity-60 text-xs">{files.filter(f => f.evaluation?.isWorthKeeping).length}</span>
                 </button>
                 <button 
                    onClick={() => setFilter('reject')}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${filter === 'reject' ? 'bg-gray-700 text-gray-200 shadow-md' : 'text-gray-400 hover:bg-gray-800'}`}
                 >
                    Rejects <span className="ml-1 opacity-60 text-xs">{files.filter(f => f.evaluation && !f.evaluation.isWorthKeeping).length}</span>
                 </button>
             </div>

             {filter === 'reject' && dirHandle && !readOnlyMode && (
                 <button 
                    onClick={handleArchiveRejects}
                    disabled={isArchiving || filteredFiles.length === 0}
                    className="flex items-center gap-2 text-xs font-bold text-red-400 hover:text-red-300 hover:bg-red-900/20 px-3 py-1.5 rounded border border-transparent hover:border-red-900/50 transition disabled:opacity-50"
                 >
                    {isArchiving ? <RefreshCw className="animate-spin" size={14} /> : <Trash2 size={14} />}
                    Clean Up Folder
                 </button>
             )}
          </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
          {files.length === 0 && !loadingFiles && (
            <div className="flex h-full flex-col items-center justify-center text-center text-gray-500 animate-in fade-in zoom-in duration-500">
              <div className="mb-6 rounded-full bg-gray-900 p-8 ring-1 ring-gray-800">
                <FolderOpen className="h-16 w-16 text-indigo-500/50" />
              </div>
              <h2 className="mb-2 text-2xl font-semibold text-white">No Folder Selected</h2>
              <p className="max-w-md mb-8">Open a local folder containing your photography. The app will automatically evaluate images and save XMP sidecars.</p>
              
              <button
                onClick={handleOpenFolder}
                className="rounded-lg bg-indigo-600 px-8 py-3 font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 mb-10"
              >
                Browse Files
              </button>

              {recentFolders.length > 0 && (
                <div className="w-full max-w-md border-t border-gray-800 pt-8">
                  <div className="flex items-center gap-2 mb-4 text-gray-400 justify-center">
                     <History size={16}/>
                     <span className="text-sm font-medium uppercase tracking-wider">Recent Folders</span>
                  </div>
                  <div className="grid gap-2">
                     {recentFolders.map(folder => (
                         <button
                           key={folder.name}
                           onClick={() => handleRecentFolderClick(folder)}
                           className="flex items-center justify-between p-3 rounded-lg bg-gray-900 border border-gray-800 hover:border-indigo-500/50 hover:bg-gray-800 transition text-left group"
                         >
                            <span className="text-gray-300 group-hover:text-white truncate">{folder.name}</span>
                            <span className="text-xs text-gray-600">{new Date(folder.lastAccessed).toLocaleDateString()}</span>
                         </button>
                     ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {dirHandle && files.length === 0 && !loadingFiles && (
             <div className="flex h-full items-center justify-center text-gray-500">
                <p>No supported images found in this folder.</p>
             </div>
          )}

          {loadingFiles && (
             <div className="flex h-full items-center justify-center gap-3 text-indigo-400">
                 <RefreshCw className="animate-spin"/>
                 <span>Scanning directory and parsing XMPs...</span>
             </div>
          )}

          {files.length > 0 && (
            <>
                {filteredFiles.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-gray-500 flex-col gap-2">
                        <Filter size={32} className="opacity-20"/>
                        <p>No files match this filter.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 pb-20">
                    {filteredFiles.map((file) => (
                        <ImageThumbnail
                        key={file.id}
                        imageFile={file}
                        isSelected={selectedFileId === file.id}
                        onClick={handleThumbnailClick}
                        />
                    ))}
                    </div>
                )}
            </>
          )}
        </div>

        <div className={`w-96 shrink-0 border-l border-gray-800 bg-gray-900 transition-all duration-300 ease-in-out ${selectedFileId ? 'translate-x-0' : 'translate-x-full hidden md:block md:translate-x-0'}`}>
           <InspectorPanel 
              file={selectedFile} 
              dirHandle={dirHandle}
              onUpdateFile={handleUpdateFile}
              onDeleteFile={handleDeleteFile}
              onClose={() => setSelectedFileId(null)}
           />
        </div>
      </div>
      
      <div className="h-8 border-t border-gray-800 bg-gray-950 px-4 flex items-center text-xs text-gray-500 justify-between">
          <div className="flex gap-4">
            <span>{filteredFiles.length} items shown</span>
            {readOnlyMode && files.length > 0 && <span className="text-yellow-500 flex items-center gap-1"><AlertCircle size={12}/> Read-only mode</span>}
          </div>
          <div className="flex gap-4">
             <span>{files.filter(f => f.evaluation?.isWorthKeeping).length} Selections</span>
          </div>
      </div>
    </div>
  );
};

export default App;
