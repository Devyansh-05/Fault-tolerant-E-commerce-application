import { useState } from 'react';

/** Product image with a graceful gradient fallback if the image is missing or fails to load. */
export default function ProductImage({ src, alt, className = '' }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`product-image fallback ${className}`} role="img" aria-label={alt}>
        <span>{alt?.charAt(0) ?? '?'}</span>
      </div>
    );
  }
  return <img className={`product-image ${className}`} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
