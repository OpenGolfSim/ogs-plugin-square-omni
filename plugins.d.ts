/**
 * The OpenGolfSim Plugin SDK
 * 
 * @packageDocumentation
 * 
 * You can extend the functionality of OpenGolfSim by creating or installing your own custom plugins.
 * 
 * For security, our Plugin SDK operates in a isolated script context. So we expose some global namespaces to enable communications with OpenGolfSim and launch monitors over network (TCP, WebSockets) or bluetooth. 
 * 
 *   - No Module System: require(), import, and export are disabled.
 *   - Global Scope: Only the specific namespaces defined below are available.
 *   - Standard JS: Only ECMAScript built-ins (e.g., `JSON`, `Map`, `Math`) are present.
 * 
 * 
 * 
 * Learn more in our plugin guide at: https://help.opengolfsim.com/desktop/plugins/
 * 
 */

declare global {
  
  /** @namespace */
  namespace logging {
    function info(...args: any[]): void
    function error(...args: any[]): void
  }
  
  /** @namespace */
  namespace system {
    /** Called before the plugin exits to allow for graceful shutdown */
    function on(eventName: 'exit', listener: () => Promise<void>): void
  }

  /**
   * Send and receive shot data from OpenGolfSim
   * @namespace
   *
   */
  namespace shotData {

    type Status = {
      isConnected: boolean;
      isReady: boolean;
      batteryLevel?: number;
      firmware?: string;
    };

    type Shot = {
      shotNumber: number;
      ballSpeed: number;
      verticalLaunchAngle: number;
      horizontalLaunchAngle: number;
      spinSpeed: number;
      spinAxis: number;
    };
    
    /** Listen for shot events */
    function on(event: 'shot', listener: (shot: Shot) => void): void;
    /** Listen for club change events */
    function on(event: 'club', listener: (clubId: string) => void): void;
    
    /** Remove a shot event listener */
    function off(event: 'shot', listener: (shot: Shot) => void): void;
    /** Remove a club event listener */
    function off(event: 'club', listener: (clubId: string) => void): void;
    
    /** Set the launch monitor status */
    function updateDeviceStatus(status: Status): void;
    
    /** Send a shot to OpenGolfSim */
    function sendShot(shot: Shot): void;
  }

  
  /**
   * Methods used for creating network (TCP) connections
   * @namespace
  */
  namespace network {
    
    interface TCPSocket {
      on(event: 'data', listener: (d: string) => void): this;
      on(event: 'connect', listener: () => void): this;
      on(event: 'close', listener: () => void): this;
      on(event: 'error', listener: (e: Error) => void): this;
      connect(port: number, host: string, callback: () => void): this;
      write(data: string | Uint8Array): void;
      destroy(): void;
    }
    
    interface TCPServer {
      on(event: 'close', listener: () => void): this;
      on(event: 'error', listener: (e: Error) => void): this;
      on(event: 'connection', listener: (socket: TCPSocket) => void): this;
      listen(port: number, callback: () => void): void;
      close(): void;
    }
    

    function createServer(onSocketConnected: (socket: TCPSocket) => void): TCPServer;
    
  }


  /**
   * Communicate with devices over bluetooth low-energy
   * @namespace
   * @example
   * const bt = bluetooth.createClient();
   * bt.on('discover', (device) => console.log('discovered device', device));
   * await bt.waitForPoweredOn();
   * await bt.startScanning();
   */
  namespace bluetooth {
    type BluetoothAdapterState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' | 'resetting';
    type BluetoothDeviceState = 'error' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected';

    /** Represents a bluetooth characteristic on the device */
    interface BluetoothCharacteristic {
      uuid: string;
      on(event: 'data', listener: (data: ArrayBufferLike, isNotification: boolean) => void): this;
      read(): Promise<ArrayBufferLike>;
      write(data: ArrayBufferLike, withoutResponse?: boolean): Promise<void>;
      subscribe(): Promise<void>;
      unsubscribe(): Promise<void>;
    }
    
    /** Represents a bluetooth service on the device */
    interface BluetoothService {
      uuid: string;
    }

    /** The advertisement data for the bluetooth device */
    interface BluetoothDeviceAdvertisement {
      localName: string;
      serviceData: {
        uuid: string,
        data: ArrayBufferLike
      }[];
      txPowerLevel: number;
      manufacturerData: ArrayBufferLike;
      serviceUuids: string[];
      serviceSolicitationUuids: string[];
    }

    /** Represents a bluetooth device */
    interface BluetoothDevice {
      readonly id: string;
      readonly address: string;
      readonly addressType: 'public' | 'random';
      readonly connectable: boolean;
      readonly advertisement: BluetoothDeviceAdvertisement;
      readonly rssi: number;
      readonly mtu: number | null;
      readonly state: BluetoothDeviceState;

      connect(): Promise<void>;
      disconnect(): Promise<void>;
      discoverAllServicesAndCharacteristics(): Promise<{
        services: BluetoothService[];
        characteristics: BluetoothCharacteristic[];
      } | undefined>;
    }
    
    /** The main bluetooth interface used for scanning and connecting to devices */
    interface BluetoothClient {
      on(event: 'stateChange', listener: (state: BluetoothAdapterState) => void): this;
      on(event: 'discover', listener: (device: BluetoothDevice) => void): this;
      waitForPoweredOn(timeout?: number): Promise<void>;
      startScanning(serviceUUIDs?: string[], allowDuplicates?: boolean): Promise<void>;
      stopScanning(): Promise<void>;
    }

    function createClient(): BluetoothClient;

  }

  namespace webSockets {

    interface WebSocket {
      /** Emitted when a new message is received */
      on(event: 'message', listener: (d: ArrayBufferLike | string) => void): this;
      /** Emitted when a socket connection is successfully established */
      on(event: 'connect', listener: () => void): this;
      /** Emitted once the socket is fully closed */
      on(event: 'close', listener: () => void): this;
      /** Emitted when an error occurs */
      on(event: 'error', listener: (e: Error) => void): this;

      off(event: 'message', listener: (d: string) => void): this;
      off(event: 'connect', listener: () => void): this;
      off(event: 'close', listener: () => void): this;
      off(event: 'error', listener: (e: Error) => void): this;
      
      send(data: ArrayBufferLike | string): void;
    }

    function createWebSocket(socketUrl: string | URL): WebSocket;
  }
}

export {};