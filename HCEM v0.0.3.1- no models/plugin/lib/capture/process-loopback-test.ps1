# 按进程采集系统声音（Application Loopback）—— IMMDevice::Activate 验证版
# 用法：powershell -File process-loopback-test.ps1 PROCESS_ID
#
# 关键（来自方案文档的修正）：
#   进程过滤不用 ActivateAudioInterfaceAsync（它不支持复杂激活参数），
#   而是用 IMMDevice::Activate + PROPVARIANT(VT_BLOB -> AUDIOCLIENT_ACTIVATION_PARAMS)。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Hcem {

  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  public enum PROCESS_LOOPBACK_MODE { INCLUDE_TARGET_PROCESS_TREE = 0, EXCLUDE_TARGET_PROCESS_TREE = 1 }

  [StructLayout(LayoutKind.Sequential)]
  public struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    public uint TargetProcessId;
    public int ProcessLoopbackMode;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct AUDIOCLIENT_ACTIVATION_PARAMS {
    public int ActivationType;   // 1 = PROCESS_LOOPBACK
    public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BLOB {
    public uint cbSize;
    public IntPtr pBlobData;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public BLOB blob;
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out object devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, ref PROPVARIANT activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    int OpenPropertyStore(int stgmAccess, out object store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  public static class Api {
    [DllImport("ole32.dll")]
    public static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")]
    public static extern void CoUninitialize();
    [DllImport("combase.dll")]
    public static extern int RoInitialize(int initType);
    [DllImport("combase.dll")]
    public static extern void RoUninitialize();

    public static string Probe(int procId) {
      string result = null;
      Thread t = new Thread(() => {
        int ro = RoInitialize(1);
        CoInitializeEx(IntPtr.Zero, 0x0);
        IntPtr blobPtr = IntPtr.Zero;
        try {
          if (ro != 0 && ro != 1) {
            result = "{\"ok\":false,\"stage\":\"roinit\",\"hr\":\"0x" + ro.ToString("X8") + "\"}";
            return;
          }

          // 1) 枚举器
          var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
          IMMDevice device;
          int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device);
          if (hr != 0) {
            result = "{\"ok\":false,\"stage\":\"endpoint\",\"hr\":\"0x" + hr.ToString("X8") + "\"}";
            return;
          }

          // 2) 激活参数（包进 PROPVARIANT/Blob）
          AUDIOCLIENT_ACTIVATION_PARAMS p = new AUDIOCLIENT_ACTIVATION_PARAMS();
          p.ActivationType = 1;
          p.ProcessLoopbackParams.TargetProcessId = (uint)procId;
          p.ProcessLoopbackParams.ProcessLoopbackMode = (int)PROCESS_LOOPBACK_MODE.INCLUDE_TARGET_PROCESS_TREE;

          int size = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
          blobPtr = Marshal.AllocHGlobal(size);
          Marshal.StructureToPtr(p, blobPtr, false);

          PROPVARIANT pv = new PROPVARIANT();
          pv.vt = 65; // VT_BLOB
          pv.blob.cbSize = (uint)size;
          pv.blob.pBlobData = blobPtr;

          // 3) 激活 IAudioClient
          Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
          object iface;
          hr = device.Activate(ref iid, 23 /*CLSCTX_ALL*/, ref pv, out iface);
          if (hr != 0) {
            result = "{\"ok\":false,\"stage\":\"activate\",\"hr\":\"0x" + hr.ToString("X8") + "\"}";
            return;
          }
          result = "{\"ok\":true,\"client\":\"" + iface.GetType().Name + "\"}";
        } catch (Exception e) {
          result = "{\"ok\":false,\"stage\":\"exception\",\"error\":\"" + e.Message.Replace("\"", "'") + "\"}";
        } finally {
          if (blobPtr != IntPtr.Zero) Marshal.FreeHGlobal(blobPtr);
          CoUninitialize();
          RoUninitialize();
        }
      });
      t.SetApartmentState(ApartmentState.MTA);
      t.IsBackground = true;
      t.Start();
      if (!t.Join(12000)) return "{\"ok\":false,\"stage\":\"thread-timeout\"}";
      return result;
    }
  }
}
"@

$procId = [int]$args[0]
if ($procId -le 0) { Write-Output '{"ok":false,"error":"need process id"}'; exit 1 }

try {
  $out = [Hcem.Api]::Probe($procId)
  Write-Output $out
} catch {
  Write-Output ('{"ok":false,"stage":"ps-exception","error":"' + $_.Exception.Message.Replace('"', "'") + '"}')
}
