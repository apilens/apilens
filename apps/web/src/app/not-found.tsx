import Link from "next/link";

export default function NotFound() {
  return (
    <div className="not-found-container">
      <h1 className="not-found-code">404</h1>
      <h2 className="not-found-title">Page not found</h2>
      <p className="not-found-description">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link href="/" className="not-found-link">
        Go back home
      </Link>
    </div>
  );
}
