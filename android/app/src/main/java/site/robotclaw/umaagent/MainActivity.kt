package site.robotclaw.umaagent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

class MainActivity : ComponentActivity() {
    private val prefs by lazy { getSharedPreferences("uma_keystore", MODE_PRIVATE) }
    private fun key(): SecretKey {
        val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("uma-pat", null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder("uma-pat", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }
    private fun savePat(value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        prefs.edit().putString("iv", Base64.getEncoder().encodeToString(cipher.iv)).putString("pat", Base64.getEncoder().encodeToString(cipher.doFinal(value.toByteArray()))).apply()
    }
    override fun onCreate(state: Bundle?) { super.onCreate(state); setContent { MaterialTheme { UmaScreen(::savePat) } } }
}

@Composable fun UmaScreen(savePat: (String) -> Unit) {
    var pat by remember { mutableStateOf("") }; var api by remember { mutableStateOf<UmaApi?>(null) }; var sessions by remember { mutableStateOf(emptyList<Session>()) }; var password by remember { mutableStateOf("") }; var xianyu by remember { mutableStateOf("") }; var error by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (api == null) { OutlinedTextField(pat, { pat = it }, Modifier.fillMaxWidth(), label = { Text("PAT") }); Button({ try { savePat(pat); api = UmaApi(pat); sessions = api!!.sessions() } catch (e: Exception) { error = e.message ?: "登录失败" } }, enabled = pat.isNotBlank()) { Text("登录") } }
        else { Text("会话", style = MaterialTheme.typography.titleLarge); LazyColumn(Modifier.weight(1f)) { items(sessions) { Text(it.title, Modifier.padding(8.dp)) } }; Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(password, { password = it }, label = { Text("咸鱼管理员密码") }); Button({ try { val grant = api!!.unlock(password).grant; xianyu = api!!.xianyuStatus(grant); password = "" } catch (e: Exception) { error = e.message ?: "解锁失败" } }) { Text("咸鱼解锁") } }; if (xianyu.isNotBlank()) Text(xianyu) }
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
    }
}
