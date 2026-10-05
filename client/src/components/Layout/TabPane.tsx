import { memo, useContext, useMemo } from 'react';
import { Box } from '@mui/material';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { PageRoutes } from '../../pageRoutes';
import { useTabsStore } from '../../store/tabs.store';
import { TabActiveContext } from './TabActiveContext';
import { splitKey, toKey } from './tabPaths';

interface Props {
  id: string;
  tabKey: string;
  active: boolean;
}

/**
 * One open tab. Stays mounted while hidden so its page keeps its state (form entries, filters,
 * scroll position). Hidden with `visibility` rather than `display:none`, which would reset the
 * scroll position and collapse any grid measuring its own width.
 */
export const TabPane = memo(function TabPane({ id, tabKey, active }: Props) {
  const parent = useContext(UNSAFE_NavigationContext);

  // A page in a background tab may still navigate — e.g. after an async save completes. That must
  // move only its own tab, never the location of whatever the user is looking at now.
  const navigation = useMemo(() => {
    if (active) return parent;
    const moveOwnTab = (to: Parameters<typeof toKey>[0]) => useTabsStore.getState().setTabKey(id, toKey(to));
    return {
      ...parent,
      navigator: { ...parent.navigator, push: moveOwnTab, replace: moveOwnTab, go: () => {} },
    };
  }, [active, parent, id]);

  const location = useMemo(() => splitKey(tabKey), [tabKey]);

  return (
    <Box
      aria-hidden={!active}
      data-tab-pane={active ? 'active' : 'hidden'}
      sx={{
        position: 'absolute', inset: 0, overflowY: 'auto', p: 3, bgcolor: 'background.default',
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <UNSAFE_NavigationContext.Provider value={navigation}>
        <TabActiveContext.Provider value={active}>
          <PageRoutes location={location} />
        </TabActiveContext.Provider>
      </UNSAFE_NavigationContext.Provider>
    </Box>
  );
});
