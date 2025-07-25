import React from 'react';

import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { ProviderOptions } from '../../types';

interface WebSocketEndpointConfigurationProps {
  selectedTarget: ProviderOptions;
  updateWebSocketTarget: (field: string, value: any) => void;
  urlError: string | null;
}

const WebSocketEndpointConfiguration: React.FC<WebSocketEndpointConfigurationProps> = ({
  selectedTarget,
  updateWebSocketTarget,
  urlError,
}) => {
  return (
    <Box mt={2}>
      <Typography variant="h6" gutterBottom>
        Custom WebSocket Endpoint Configuration
      </Typography>
      <Box mt={2} p={2} border={1} borderColor="grey.300" borderRadius={1}>
        <TextField
          fullWidth
          label="WebSocket URL"
          value={selectedTarget.config.url}
          onChange={(e) => updateWebSocketTarget('url', e.target.value)}
          margin="normal"
          error={!!urlError}
          helperText={urlError}
        />
        <TextField
          fullWidth
          label="Message Template"
          value={selectedTarget.config.messageTemplate}
          onChange={(e) => updateWebSocketTarget('messageTemplate', e.target.value)}
          margin="normal"
          multiline
          rows={3}
        />
        <TextField
          fullWidth
          label="Response Transform"
          value={selectedTarget.config.transformResponse}
          onChange={(e) => updateWebSocketTarget('transformResponse', e.target.value)}
          margin="normal"
        />
        <TextField
          fullWidth
          label="Timeout (ms)"
          type="number"
          value={selectedTarget.config.timeoutMs || 5000}
          onChange={(e) => updateWebSocketTarget('timeoutMs', Number.parseInt(e.target.value, 10))}
          sx={{ mb: 2 }}
        />
      </Box>
    </Box>
  );
};

export default WebSocketEndpointConfiguration;
