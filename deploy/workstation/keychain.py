"""Read the recovery-volume password from this user's login Keychain."""
import ctypes as c
import secrets


def password(create=False):
    sec=c.CDLL('/System/Library/Frameworks/Security.framework/Security')
    sec.SecKeychainSetUserInteractionAllowed(False)
    service=b'Cmonitor encrypted recovery volume'; account=b'local-maintenance'
    size=c.c_uint32(); ptr=c.c_void_p()
    args=(None,len(service),service,len(account),account)
    status=sec.SecKeychainFindGenericPassword(*args,c.byref(size),c.byref(ptr),None)
    if status==0:
        try: return c.string_at(ptr,size.value)
        finally: sec.SecKeychainItemFreeContent(None,ptr)
    if status!=-25300 or not create:raise RuntimeError(f'login Keychain unavailable ({status})')
    value=secrets.token_urlsafe(48).encode(); status=sec.SecKeychainAddGenericPassword(*args,len(value),value,None)
    if status:raise RuntimeError(f'cannot store recovery key ({status})')
    return value
