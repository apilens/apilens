"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

interface ImageViewModalProps {
  src: string;
  onClose: () => void;
}

export default function ImageViewModal({ src, onClose }: ImageViewModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="image-view-overlay" onClick={onClose}>
      <button className="image-view-close" onClick={onClose}>
        <X size={24} />
      </button>
      <div className="image-view-content" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="Profile picture" />
      </div>
    </div>
  );
}
