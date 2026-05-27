"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X, Upload, Minus, Plus, Loader2 } from "lucide-react";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const CANVAS_SIZE = 300;

interface ProfilePictureEditorProps {
  currentPicture?: string;
  onSave: (blob: Blob) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

type Step = "dropzone" | "crop";

export default function ProfilePictureEditor({
  currentPicture,
  onSave,
  onRemove,
  onClose,
}: ProfilePictureEditorProps) {
  const [step, setStep] = useState<Step>("dropzone");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return "Only JPEG, PNG, and WebP images are allowed";
    }
    if (file.size > MAX_SIZE) {
      return "Image must be smaller than 5MB";
    }
    return null;
  };

  const loadImage = (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    const url = URL.createObjectURL(file);
    setImageSrc(url);

    const img = new Image();
    img.onload = () => {
      setImageEl(img);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setStep("crop");
    };
    img.src = url;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadImage(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadImage(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  // Draw image on canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !imageEl) return;

    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Dark background
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Calculate scaling: fit image into canvas then apply zoom
    const scale = Math.max(CANVAS_SIZE / imageEl.width, CANVAS_SIZE / imageEl.height) * zoom;
    const drawW = imageEl.width * scale;
    const drawH = imageEl.height * scale;
    const drawX = (CANVAS_SIZE - drawW) / 2 + offset.x;
    const drawY = (CANVAS_SIZE - drawH) / 2 + offset.y;

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(imageEl, drawX, drawY, drawW, drawH);
    ctx.restore();

    // Circle border guide (semi-transparent ring outside the circle)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fill();
    ctx.restore();
  }, [imageEl, zoom, offset]);

  useEffect(() => {
    if (step === "crop") drawCanvas();
  }, [step, drawCanvas]);

  // Pointer events for dragging
  const handlePointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handlePointerUp = () => setDragging(false);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    setZoom((z) => Math.min(3, Math.max(1, z + delta)));
  };

  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsSaving(true);
    try {
      // Create a clean output canvas (no overlay)
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = CANVAS_SIZE;
      outputCanvas.height = CANVAS_SIZE;
      const ctx = outputCanvas.getContext("2d")!;

      const scale = Math.max(CANVAS_SIZE / imageEl!.width, CANVAS_SIZE / imageEl!.height) * zoom;
      const drawW = imageEl!.width * scale;
      const drawH = imageEl!.height * scale;
      const drawX = (CANVAS_SIZE - drawW) / 2 + offset.x;
      const drawY = (CANVAS_SIZE - drawH) / 2 + offset.y;

      ctx.beginPath();
      ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(imageEl!, drawX, drawY, drawW, drawH);

      const blob = await new Promise<Blob>((resolve, reject) => {
        outputCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create image"))),
          "image/jpeg",
          0.9,
        );
      });

      await onSave(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      await onRemove();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setIsRemoving(false);
    }
  };

  const handleChangeImage = () => {
    if (imageSrc) URL.revokeObjectURL(imageSrc);
    setImageSrc(null);
    setImageEl(null);
    setStep("dropzone");
    setError(null);
  };

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (imageSrc) URL.revokeObjectURL(imageSrc);
    };
  }, [imageSrc]);

  return (
    <div className="picture-editor-overlay" onClick={onClose}>
      <div className="picture-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="picture-editor-header">
          <h3>Profile Picture</h3>
          <button className="picture-editor-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="picture-editor-content">
          {error && (
            <p style={{ color: "var(--danger)", fontSize: "13px", margin: "0 0 16px" }}>
              {error}
            </p>
          )}

          {step === "dropzone" && (
            <div
              className={`picture-editor-dropzone${isDragOver ? " dragging" : ""}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileSelect}
                hidden
              />
              <div className="dropzone-content">
                <div className="dropzone-icon">
                  <Upload size={24} />
                </div>
                <p className="dropzone-title">Upload a photo</p>
                <p className="dropzone-hint">Drag and drop or click to browse</p>
                <p className="dropzone-formats">JPEG, PNG, or WebP up to 5MB</p>
              </div>

              {currentPicture && (
                <div className="dropzone-current">
                  <p className="dropzone-current-label">Current picture</p>
                  <div className="dropzone-current-preview">
                    <img src={currentPicture} alt="Current" />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "crop" && (
            <div className="picture-editor-cropper">
              <div className="cropper-container">
                <canvas
                  ref={canvasRef}
                  width={CANVAS_SIZE}
                  height={CANVAS_SIZE}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    cursor: dragging ? "grabbing" : "grab",
                    touchAction: "none",
                  }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onWheel={handleWheel}
                />
              </div>

              <div className="cropper-controls">
                <button
                  className="zoom-btn"
                  onClick={() => setZoom((z) => Math.max(1, z - 0.1))}
                  disabled={zoom <= 1}
                >
                  <Minus size={16} />
                </button>
                <input
                  type="range"
                  className="zoom-slider"
                  min="1"
                  max="3"
                  step="0.01"
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                />
                <button
                  className="zoom-btn"
                  onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
                  disabled={zoom >= 3}
                >
                  <Plus size={16} />
                </button>
              </div>

              <div style={{ textAlign: "center" }}>
                <button className="change-image-btn" onClick={handleChangeImage}>
                  Choose a different image
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="picture-editor-footer">
          {currentPicture && (
            <button
              className="picture-editor-btn danger"
              onClick={handleRemove}
              disabled={isSaving || isRemoving}
            >
              {isRemoving ? <Loader2 size={14} className="animate-spin" /> : "Remove"}
            </button>
          )}
          <div className="picture-editor-footer-right">
            <button
              className="picture-editor-btn secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </button>
            {step === "crop" && (
              <button
                className="picture-editor-btn primary"
                onClick={handleSave}
                disabled={isSaving || !imageEl}
              >
                {isSaving ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
