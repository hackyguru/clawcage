// TerminalView - terminal + stats bar
import Terminal from '../components/Terminal';
import StatsBar from '../components/StatsBar';

export default function TerminalView() {
  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-1 min-h-0">
        <Terminal />
      </div>
      <StatsBar />
    </div>
  );
}
