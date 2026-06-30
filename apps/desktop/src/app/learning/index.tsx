import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { $learningError, $learningGraph, $learningLoading, loadLearningGraph } from '@/store/learning'

import { Panel, PanelEmpty, PanelHeader } from '../overlays/panel'

import { StarMap } from './star-map'

// Learning overlay: a top-down star map of what Hermes has learned for a
// profile, over a radial time axis. Data is fetched on demand into the
// $learning* atoms; the map itself lives in ./star-map.
export function LearningView({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const graph = useStore($learningGraph)
  const loading = useStore($learningLoading)
  const error = useStore($learningError)

  useEffect(() => {
    void loadLearningGraph()
  }, [])

  const skillCount = graph ? graph.nodes.filter(n => n.kind === 'skill').length : 0
  const memoryCount = graph ? graph.nodes.filter(n => n.kind === 'memory').length : 0
  const subtitle = graph ? `${skillCount} learned skills · ${memoryCount} memories, over time` : undefined

  return (
    <Panel closeLabel={t.learning.close} onClose={onClose}>
      <PanelHeader subtitle={subtitle} title={t.learning.title} />

      {error ? (
        <PanelEmpty description={error} icon="warning" title={t.learning.loadFailed} />
      ) : !graph && loading ? (
        <div aria-label={t.learning.loading} className="grid flex-1 place-items-center" role="status">
          <Loader className="size-12 text-muted-foreground" strokeScale={0.72} type="spiral-search" />
        </div>
      ) : graph && graph.nodes.length === 0 ? (
        <PanelEmpty description={t.learning.emptyDesc} icon="lightbulb" title={t.learning.emptyTitle} />
      ) : graph ? (
        <StarMap graph={graph} />
      ) : null}
    </Panel>
  )
}
