#include <jni.h>
#include <android/log.h>
#include <string>
#include <sstream>

#define LOG_TAG "MyGameBabylonNative"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static JavaVM *g_javaVM = nullptr;
static jobject g_activity = nullptr;

jint JNI_OnLoad(JavaVM *vm, void *) {
    g_javaVM = vm;
    return JNI_VERSION_1_6;
}

static std::string JsQuote(const std::string &input) {
    std::ostringstream out;

    out << "\"";

    for (char c : input) {
        switch (c) {
            case '"':
                out << "\\\"";
                break;
            case '\\':
                out << "\\\\";
                break;
            case '\n':
                out << "\\n";
                break;
            case '\r':
                out << "\\r";
                break;
            case '\t':
                out << "\\t";
                break;
            default:
                out << c;
                break;
        }
    }

    out << "\"";

    return out.str();
}

static void ForwardToJs(const std::string &jsCode) {
    /*
        TODO: هنا يجب إرسال الكود إلى JavaScript داخل Babylon Native.

        غالباً يكون عندك شيء مثل:

        runtime->Dispatch([jsCode](Napi::Env env) {
            auto global = env.Global();
            auto eval = global.Get("eval").As<Napi::Function>();
            eval.Call(global, { Napi::String::New(env, jsCode) });
        });

        إذا لم تكن قد ربطت Babylon Native بعد، سنطبع الرسالة فقط.
    */

    LOGI("ForwardToJs: %s", jsCode.c_str());
}

static JNIEnv *GetEnv(bool &attached) {
    JNIEnv *env = nullptr;
    attached = false;

    if (g_javaVM == nullptr) {
        return nullptr;
    }

    int status = g_javaVM->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);

    if (status == JNI_EDETACHED) {
        if (g_javaVM->AttachCurrentThread(&env, nullptr) != 0) {
            return nullptr;
        }
        attached = true;
    }

    return env;
}

static void ReleaseEnv(bool attached) {
    if (attached && g_javaVM != nullptr) {
        g_javaVM->DetachCurrentThread();
    }
}

static void CallJavaVoid(const char *methodName) {
    bool attached = false;
    JNIEnv *env = GetEnv(attached);

    if (env == nullptr || g_activity == nullptr) {
        return;
    }

    jclass cls = env->GetObjectClass(g_activity);
    jmethodID method = env->GetMethodID(cls, methodName, "()V");

    if (method != nullptr) {
        env->CallVoidMethod(g_activity, method);
    }

    ReleaseEnv(attached);
}

static void CallJavaString(const char *methodName, const std::string &value) {
    bool attached = false;
    JNIEnv *env = GetEnv(attached);

    if (env == nullptr || g_activity == nullptr) {
        return;
    }

    jclass cls = env->GetObjectClass(g_activity);
    jmethodID method = env->GetMethodID(cls, methodName, "(Ljava/lang/String;)V");

    if (method != nullptr) {
        jstring jvalue = env->NewStringUTF(value.c_str());
        env->CallVoidMethod(g_activity, method, jvalue);
        env->DeleteLocalRef(jvalue);
    }

    ReleaseEnv(attached);
}

static void CallJavaStringInt(
        const char *methodName,
        const std::string &stringValue,
        int intValue
) {
    bool attached = false;
    JNIEnv *env = GetEnv(attached);

    if (env == nullptr || g_activity == nullptr) {
        return;
    }

    jclass cls = env->GetObjectClass(g_activity);
    jmethodID method = env->GetMethodID(
            cls,
            methodName,
            "(Ljava/lang/String;I)V"
    );

    if (method != nullptr) {
        jstring jvalue = env->NewStringUTF(stringValue.c_str());
        env->CallVoidMethod(g_activity, method, jvalue, intValue);
        env->DeleteLocalRef(jvalue);
    }

    ReleaseEnv(attached);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_mygame_GameNativeActivity_nativeInit(JNIEnv *env, jobject activity) {
    if (g_activity != nullptr) {
        env->DeleteGlobalRef(g_activity);
    }

    g_activity = env->NewGlobalRef(activity);

    LOGI("Babylon Native host initialized");

    /*
        TODO: هنا تهيئ Babylon Native:
        - إنشاء GraphicsDevice
        - إنشاء Window من NativeWindow
        - إنشاء AppRuntime
        - تحميل assets/scripts/game.js
        - تسجيل كائن JavaScript باسم AndroidBridge

        مثال مطلوب داخل JavaScript:

        window.AndroidBridge = {
            startHost: () => native call startHostFromJs(),
            discover: () => native call discoverFromJs(),
            join: (host, port) => native call joinFromJs(host, port),
            send: (json) => native call sendFromJs(json),
            getDeviceName: () => native call getDeviceNameFromJs(),
            getMyId: () => native call getMyIdFromJs(),
            setMyId: (id) => native call setMyIdFromJs(id)
        };
    */
}

extern "C"
JNIEXPORT void JNICALL
Java_com_mygame_GameNativeActivity_nativeNetworkMessage(
        JNIEnv *env,
        jobject,
        jstring json
) {
    const char *raw = env->GetStringUTFChars(json, nullptr);
    std::string message = raw ? raw : "";
    env->ReleaseStringUTFChars(json, raw);

    std::string code =
            "window.NetworkBridge && window.NetworkBridge.receive(" +
            JsQuote(message) +
            ");";

    ForwardToJs(code);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_mygame_GameNativeActivity_nativeDeviceFound(
        JNIEnv *env,
        jobject,
        jstring name,
        jstring host,
        jint port
) {
    const char *rawName = env->GetStringUTFChars(name, nullptr);
    const char *rawHost = env->GetStringUTFChars(host, nullptr);

    std::string deviceName = rawName ? rawName : "";
    std::string deviceHost = rawHost ? rawHost : "";

    env->ReleaseStringUTFChars(name, rawName);
    env->ReleaseStringUTFChars(host, rawHost);

    std::string code =
            "window.NetworkBridge && window.NetworkBridge.onDeviceFound(" +
            JsQuote(deviceName) + ", " +
            JsQuote(deviceHost) + ", " +
            std::to_string(port) +
            ");";

    ForwardToJs(code);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_mygame_GameNativeActivity_nativeDeviceLost(
        JNIEnv *env,
        jobject,
        jstring name
) {
    const char *rawName = env->GetStringUTFChars(name, nullptr);
    std::string deviceName = rawName ? rawName : "";
    env->ReleaseStringUTFChars(name, rawName);

    std::string code =
            "window.NetworkBridge && window.NetworkBridge.onDeviceLost(" +
            JsQuote(deviceName) +
            ");";

    ForwardToJs(code);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_mygame_GameNativeActivity_nativeLog(
        JNIEnv *env,
        jobject,
        jstring message
) {
    const char *raw = env->GetStringUTFChars(message, nullptr);
    std::string text = raw ? raw : "";
    env->ReleaseStringUTFChars(message, raw);

    std::string code =
            "window.NetworkBridge && window.NetworkBridge.onLog(" +
            JsQuote(text) +
            ");";

    ForwardToJs(code);
}

/*
    هذه الدوال يمكن استخدامها لاحقاً من JavaScript Bridge:

    void JsStartHost() {
        CallJavaVoid("startHostFromJs");
    }

    void JsDiscover() {
        CallJavaVoid("discoverFromJs");
    }

    void JsJoin(const std::string &host, int port) {
        CallJavaStringInt("joinFromJs", host, port);
    }

    void JsSend(const std::string &json) {
        CallJavaString("sendFromJs", json);
    }
*/
