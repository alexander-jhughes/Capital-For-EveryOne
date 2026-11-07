// Remounts on navigation: a short fade between pages. The reduced-motion rule in globals.css turns it off.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-in fade-in duration-200">{children}</div>;
}
