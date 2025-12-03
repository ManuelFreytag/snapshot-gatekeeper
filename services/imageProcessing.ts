
export const resizeImage = async (file: File, maxDimension: number = 1500): Promise<{ base64: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Calculate new dimensions
        if (width > height) {
          if (width > maxDimension) {
            height = Math.round(height * (maxDimension / width));
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round(width * (maxDimension / height));
            height = maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            reject(new Error("Could not get canvas context"));
            return;
        }
        
        ctx.drawImage(img, 0, 0, width, height);
        
        // Export as JPEG with reasonable compression
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const base64 = dataUrl.split(',')[1];
        
        resolve({
          base64,
          mimeType: 'image/jpeg'
        });
      };
      img.onerror = (e) => reject(e);
    };
    reader.onerror = (e) => reject(e);
  });
};

export const getDateTaken = async (file: File): Promise<number> => {
  return new Promise((resolve) => {
    // Fallback to lastModified immediately if not JPEG/JPG
    // PNG/WebP usually don't have standard EXIF in the same structure or are used for screenshots
    if (file.type !== 'image/jpeg' && file.type !== 'image/jpg') {
      resolve(file.lastModified);
      return;
    }

    const reader = new FileReader();
    // Read first 64KB, which is usually enough to contain the EXIF header
    reader.readAsArrayBuffer(file.slice(0, 65536));

    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        if (!buffer) {
             resolve(file.lastModified);
             return;
        }
        const view = new DataView(buffer);
        
        // Check for JPEG SOI marker (0xFFD8)
        if (view.getUint16(0, false) !== 0xFFD8) {
           resolve(file.lastModified);
           return;
        }

        let offset = 2;
        const length = view.byteLength;

        while (offset < length) {
          const marker = view.getUint16(offset, false);
          offset += 2;

          if (marker === 0xFFE1) {
             // Found APP1 marker (where Exif lives)
             const app1Length = view.getUint16(offset, false);
             // Check for "Exif" ascii signature
             if (view.getUint32(offset + 2, false) === 0x45786966) { 
                const tiffStart = offset + 8;
                // Byte order: 0x4949 = Little Endian, 0x4D4D = Big Endian
                const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
                
                // Verify TIFF signature (0x002A)
                if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002A) {
                    resolve(file.lastModified);
                    return;
                }

                const firstIFDOffset = view.getUint32(tiffStart + 4, littleEndian);
                if (firstIFDOffset < 0x00000008) {
                    resolve(file.lastModified);
                    return;
                }

                let dirStart = tiffStart + firstIFDOffset;
                const entries = view.getUint16(dirStart, littleEndian);
                
                for (let i = 0; i < entries; i++) {
                   const entryOffset = dirStart + 2 + (i * 12);
                   const tag = view.getUint16(entryOffset, littleEndian);
                   
                   // Tag 0x9003 is DateTimeOriginal
                   if (tag === 0x9003) {
                      const valueOffset = view.getUint32(entryOffset + 8, littleEndian);
                      // It points to a string in the file (relative to tiffStart)
                      const stringOffset = tiffStart + valueOffset;
                      
                      // Read the date string (Format: "YYYY:MM:DD HH:MM:SS")
                      let dateString = "";
                      for (let j = 0; j < 19; j++) {
                          dateString += String.fromCharCode(view.getUint8(stringOffset + j));
                      }
                      
                      // Convert colon separated date to slash separated for Date constructor
                      // "2023:10:25 14:30:00" -> "2023/10/25 14:30:00"
                      const formattedDate = dateString.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3');
                      const timestamp = new Date(formattedDate).getTime();
                      
                      if (!isNaN(timestamp)) {
                          resolve(timestamp);
                          return;
                      }
                   }
                }
             }
             offset += app1Length;
          } else if ((marker & 0xFF00) !== 0xFF00) {
             // Not a valid marker
             break;
          } else {
             // Skip other markers
             offset += view.getUint16(offset, false);
          }
        }
        resolve(file.lastModified);
      } catch (err) {
        console.warn("EXIF parsing failed, falling back to file modified date", err);
        resolve(file.lastModified);
      }
    };
    
    reader.onerror = () => resolve(file.lastModified);
  });
};
