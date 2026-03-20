import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    // Explicitly declare props to avoid TS errors in some environments
    readonly props: Readonly<Props>;

    constructor(props: Props) {
        super(props);
        this.props = props;
    }

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }
    
    private handleReload = () => {
        window.location.reload();
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center min-h-screen bg-bg-dark p-4 text-center">
                    <h1 className="text-2xl font-bold text-red-400 mb-4">
                        이런! 예상치 못한 오류가 발생했습니다.
                    </h1>
                    <p className="text-text-secondary mb-6">
                        애플리케이션에 문제가 발생하여 정상적으로 표시할 수 없습니다.
                    </p>
                    <button
                        onClick={this.handleReload}
                        className="px-6 py-2 text-sm font-bold text-white bg-brand-primary rounded-md hover:bg-brand-secondary transition-colors"
                    >
                        애플리케이션 새로고침
                    </button>
                     {this.state.error && (
                        <details className="mt-8 text-left max-w-xl w-full">
                            <summary className="text-xs text-text-secondary cursor-pointer">오류 세부 정보 보기</summary>
                            <pre className="mt-2 p-3 bg-bg-light border border-border-color rounded-md text-xs text-red-300 overflow-auto">
                                {this.state.error.stack}
                            </pre>
                        </details>
                    )}
                </div>
            );
        }

        return this.props.children;
    }
}