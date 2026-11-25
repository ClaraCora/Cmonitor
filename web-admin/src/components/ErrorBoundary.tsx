import { Component, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div role="alert" className="grid min-h-svh place-content-center gap-4 p-6 text-center">
      <p>页面遇到异常，请重新加载。仍有问题时请联系管理员。</p>
      <Button variant="outline" onClick={() => location.reload()}>重新加载</Button>
    </div>
    return this.props.children
  }
}
