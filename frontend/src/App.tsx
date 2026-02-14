import { Routes, Route } from 'react-router-dom';
import { lazy, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import TopPage from './pages/TopPage';

// HostPage / GuestPage は遅延ロードにして初期バンドルを軽量化
const HostPage = lazy(() => import('./pages/HostPage'));
const GuestPage = lazy(() => import('./pages/GuestPage'));

/** 全画面ローディング表示 */
function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900">
      <p className="text-slate-400">読み込み中...</p>
    </div>
  );
}

/** エラーバウンダリ: 描画エラーを画面に表示 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 px-4">
          <h1 className="text-2xl font-bold text-red-400">描画エラー</h1>
          <pre className="mt-4 max-w-2xl overflow-auto rounded bg-slate-800 p-4 text-sm text-red-300">
            {this.state.error.message}
            {'\n'}
            {this.state.error.stack}
          </pre>
          <button
            className="mt-4 rounded bg-indigo-600 px-4 py-2 text-white"
            onClick={() => this.setState({ error: null })}
          >
            再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/" element={<TopPage />} />
          <Route path="/host/:roomId" element={<HostPage />} />
          <Route path="/guest/:roomId" element={<GuestPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
